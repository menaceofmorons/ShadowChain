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

type integrationStack struct {
	db     *sqlite.DB
	stats  *sqlite.Stats
	store  *sqlite.Store
	reader *sqlite.Reader
	maint  *sqlite.Maintenance
}

func openIntegrationStack(t *testing.T) integrationStack {
	t.Helper()
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
	return integrationStack{db: db, stats: stats, store: st, reader: sqlite.NewReader(db, stats), maint: sqlite.NewMaintenance(st, stats)}
}

func runIntegrationWorkload(t *testing.T, stack integrationStack) {
	t.Helper()
	ctx := context.Background()
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
				if _, err := stack.store.ApplyPaste(ctx, store.TenantID(tenant), cmd); err != nil {
					fail(fmt.Errorf("paste tenant %d round %d: %w", tenant, round, err))
				}
				if _, err := stack.reader.ReadSnapshot(ctx, store.TenantID(tenant)); err != nil {
					fail(fmt.Errorf("snapshot tenant %d: %w", tenant, err))
				}
			}
		})
	}
	wg.Wait()
	for _, err := range failures {
		t.Error(err)
	}
}

func TestIntegrationHundredTenantsShareOneStack(t *testing.T) {
	ctx := context.Background()
	stack := openIntegrationStack(t)
	db, stats, reader, maint := stack.db, stack.stats, stack.reader, stack.maint

	helpers, stopHelpers := context.WithCancel(ctx)
	var helperWG sync.WaitGroup
	helperWG.Go(func() { _ = maint.Run(helpers, 50*time.Millisecond, 10*time.Millisecond) })

	runIntegrationWorkload(t, stack)
	stopHelpers()
	helperWG.Wait()

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

	res, err := maint.Checkpoint(ctx)
	if err != nil || res.Busy {
		t.Fatalf("checkpoint with no readers: %+v, %v", res, err)
	}
	after, err := maint.SampleWAL()
	if err != nil {
		t.Fatalf("sample WAL: %v", err)
	}
	if after != 0 || stats.WALSize() != 0 {
		t.Errorf("WAL after TRUNCATE checkpoint = %d (stats %d), want 0", after, stats.WALSize())
	}
}

func TestIntegrationHeldReaderNeverStallsWritersAndWALRecovers(t *testing.T) {
	ctx := context.Background()
	stack := openIntegrationStack(t)
	maint := stack.maint.WithCheckpointRetry(20 * time.Millisecond)

	conn, err := stack.db.Reader().Conn(ctx)
	if err != nil {
		t.Fatalf("reader conn: %v", err)
	}
	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		t.Fatalf("begin: %v", err)
	}
	var held int
	if err := conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM signature").Scan(&held); err != nil {
		t.Fatalf("hold snapshot: %v", err)
	}
	released := false
	release := func() {
		if released {
			return
		}
		released = true
		if _, err := conn.ExecContext(ctx, "ROLLBACK"); err != nil {
			t.Errorf("rollback: %v", err)
		}
		_ = conn.Close()
	}
	defer release()

	helpers, stopHelpers := context.WithCancel(ctx)
	var helperWG sync.WaitGroup
	helperWG.Go(func() { _ = maint.Run(helpers, 30*time.Millisecond, 10*time.Millisecond) })
	defer func() {
		stopHelpers()
		helperWG.Wait()
	}()

	runIntegrationWorkload(t, stack)

	deadline := time.Now().Add(5 * time.Second)
	for maint.BusyCheckpoints() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if maint.BusyCheckpoints() == 0 {
		t.Fatal("no busy TRUNCATE recorded while a reader held the WAL")
	}
	bound := sqlite.CheckpointMaxWait + time.Second
	if max := stack.stats.QueueWait().Max; max > bound {
		t.Errorf("max queue wait %v with a reader holding the WAL, want within %v", max, bound)
	}
	if size, err := maint.SampleWAL(); err != nil || size == 0 {
		t.Fatalf("WAL size %d (%v) while reader held, want it pinned above zero", size, err)
	}

	release()
	for time.Now().Before(deadline) {
		if size, err := maint.SampleWAL(); err == nil && size == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if size, err := maint.SampleWAL(); err != nil || size != 0 {
		t.Errorf("WAL size %d (%v) after reader released, want 0 from the retried TRUNCATE", size, err)
	}
	if n, last := maint.Failures(); n != 0 {
		t.Errorf("busy checkpoints counted as failures: %d, %v", n, last)
	}
}

func TestIntegrationMaintenanceNeverCountsAsWriteCommand(t *testing.T) {
	ctx := context.Background()
	stack := openIntegrationStack(t)
	runIntegrationWorkload(t, stack)

	queueBefore, latencyBefore := stack.stats.QueueWait().Count, stack.stats.WriteLatency().Count
	if queueBefore == 0 || latencyBefore == 0 {
		t.Fatalf("workload recorded no write samples: queue %d, latency %d", queueBefore, latencyBefore)
	}
	if _, err := stack.maint.Checkpoint(ctx); err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if err := stack.maint.RunOnce(ctx); err != nil {
		t.Fatalf("run once: %v", err)
	}
	if got := stack.stats.QueueWait().Count; got != queueBefore {
		t.Errorf("queue wait samples %d after maintenance, want %d: maintenance must not count as a write command", got, queueBefore)
	}
	if got := stack.stats.WriteLatency().Count; got != latencyBefore {
		t.Errorf("write latency samples %d after maintenance, want %d", got, latencyBefore)
	}
}
