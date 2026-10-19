package sqlite_test

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/menaceofmorons/ShadowChain/internal/store"
	"github.com/menaceofmorons/ShadowChain/internal/store/sqlite"
)

const (
	integrationTenants   = 100
	integrationRounds    = 3
	integrationPasteSize = 12
)

func integrationLines(tenant, round int) []store.PasteLine {
	lines := make([]store.PasteLine, integrationPasteSize)
	for i := range lines {
		lines[i] = store.PasteLine{
			SigCode:   fmt.Sprintf("ABC-%03d", round*integrationPasteSize+i),
			ScanKind:  "signature",
			SiteGroup: "gas",
			SiteName:  fmt.Sprintf("Site %d", tenant),
		}
	}
	return lines
}

func TestIntegrationHundredTenantsShareOneStack(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "integration.db"), sqlite.Options{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := sqlite.ApplyTestSchema(ctx, db.Writer()); err != nil {
		t.Fatalf("schema: %v", err)
	}
	for id := 1; id <= integrationTenants; id++ {
		if _, err := db.Writer().ExecContext(ctx, `INSERT INTO tenant (id) VALUES (?)`, id); err != nil {
			t.Fatalf("tenant %d: %v", id, err)
		}
	}

	stats := sqlite.NewStats()
	st := sqlite.NewStore(db, stats)
	t.Cleanup(st.Close)
	reader := sqlite.NewReader(db, stats)
	maint := sqlite.NewMaintenance(st, stats)

	helpers, stopHelpers := context.WithCancel(ctx)
	var helperWG sync.WaitGroup
	helperWG.Go(func() { _ = maint.Run(helpers, 50*time.Millisecond, 10*time.Millisecond) })

	var (
		mu       sync.Mutex
		failures []error
		wg       sync.WaitGroup
	)
	fail := func(err error) {
		mu.Lock()
		defer mu.Unlock()
		failures = append(failures, err)
	}
	actor := store.Actor{CharacterID: 4242, Name: "Integrator"}
	for tenant := 1; tenant <= integrationTenants; tenant++ {
		wg.Go(func() {
			for round := range integrationRounds {
				cmd := store.PasteCommand{SystemID: store.SystemID(30000000 + tenant), Actor: actor, Lines: integrationLines(tenant, round)}
				if _, err := st.ApplyPaste(ctx, store.TenantID(tenant), cmd); err != nil {
					fail(fmt.Errorf("paste tenant %d round %d: %w", tenant, round, err))
				}
				if _, err := reader.ReadSnapshot(ctx, store.TenantID(tenant)); err != nil {
					fail(fmt.Errorf("snapshot tenant %d: %w", tenant, err))
				}
			}
		})
	}
	wg.Wait()
	stopHelpers()
	helperWG.Wait()
	for _, err := range failures {
		t.Error(err)
	}

	wantBatches := integrationTenants * integrationRounds
	var batches int
	if err := db.Reader().QueryRow(`SELECT COUNT(DISTINCT batch_id) FROM change_log`).Scan(&batches); err != nil {
		t.Fatalf("count batches: %v", err)
	}
	if got := batches; got != wantBatches {
		t.Errorf("distinct change-log batches = %d, want %d (one per command)", got, wantBatches)
	}
	wantSigs := integrationRounds * integrationPasteSize
	for tenant := 1; tenant <= integrationTenants; tenant++ {
		snap, err := reader.ReadSnapshot(ctx, store.TenantID(tenant))
		if err != nil {
			t.Fatalf("final snapshot tenant %d: %v", tenant, err)
		}
		if len(snap.Signatures) != wantSigs {
			t.Fatalf("tenant %d signatures = %d, want %d", tenant, len(snap.Signatures), wantSigs)
		}
		for _, s := range snap.Signatures {
			if s.TenantID != store.TenantID(tenant) {
				t.Fatalf("tenant %d snapshot holds a row of tenant %d", tenant, s.TenantID)
			}
		}
	}

	if got := stats.WriteLatency().Count; got < int64(wantBatches) {
		t.Errorf("write latency samples = %d, want at least %d", got, wantBatches)
	}
	if got := stats.QueueWait().Count; got < int64(wantBatches) {
		t.Errorf("queue wait samples = %d, want at least %d", got, wantBatches)
	}
	if stats.SnapshotLatency().Count < int64(wantBatches) {
		t.Errorf("snapshot samples = %d, want at least %d", stats.SnapshotLatency().Count, wantBatches)
	}

	if open := db.Writer().Stats().MaxOpenConnections; open != 1 {
		t.Errorf("writer MaxOpenConnections = %d, want 1", open)
	}
	if size := db.Reader().Stats().MaxOpenConnections; size < sqlite.MinReadPool || size > sqlite.MaxReadPool {
		t.Errorf("read pool = %d, want %d..%d", size, sqlite.MinReadPool, sqlite.MaxReadPool)
	}

	if _, err := maint.Checkpoint(ctx); err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	after, err := maint.SampleWAL()
	if err != nil {
		t.Fatalf("sample WAL: %v", err)
	}
	if after != 0 || stats.WALSize() != 0 {
		t.Errorf("WAL after TRUNCATE checkpoint = %d (stats %d), want 0", after, stats.WALSize())
	}
}
