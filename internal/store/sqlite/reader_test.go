package sqlite_test

import (
	"context"
	"database/sql"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/menaceofmorons/ShadowChain/internal/store"
	"github.com/menaceofmorons/ShadowChain/internal/store/sqlite"
)

type fakeStats struct {
	mu        sync.Mutex
	snapshots []time.Duration
	walSizes  []int64
}

func (f *fakeStats) RecordQueueWait(time.Duration)    {}
func (f *fakeStats) RecordWriteLatency(time.Duration) {}
func (f *fakeStats) RecordSnapshotLatency(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snapshots = append(f.snapshots, d)
}
func (f *fakeStats) RecordWALSize(b int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.walSizes = append(f.walSizes, b)
}

func (f *fakeStats) snapshotCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.snapshots)
}

func (f *fakeStats) lastWAL() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.walSizes[len(f.walSizes)-1]
}

func openSeeded(t *testing.T) *sqlite.DB {
	t.Helper()
	db := openTemp(t, sqlite.Options{})
	ctx := context.Background()
	if err := sqlite.ApplyTestSchema(ctx, db.Writer()); err != nil {
		t.Fatalf("schema: %v", err)
	}
	for _, id := range []int64{1, 2} {
		if _, err := db.Writer().ExecContext(ctx, "INSERT INTO tenant (id) VALUES (?)", id); err != nil {
			t.Fatalf("tenant: %v", err)
		}
	}
	return db
}

func insertSignature(ctx context.Context, tx *sql.Tx, tenant int64, system int64, code string) (int64, error) {
	res, err := tx.ExecContext(ctx, `INSERT INTO signature
		(tenant_id, system_id, sig_code, scan_kind, site_group, site_name, name_source, created_at, created_by, modified_at, modified_by)
		VALUES (?, ?, ?, 'signature', 'wormhole', 'Wormhole', 'paste', 1, 1, 1, 1)`, tenant, system, code)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func insertWormhole(ctx context.Context, tx *sql.Tx, tenant, system, sigID int64) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO connection
		(tenant_id, kind, sig_a_id, system_a_id, leads_to_source, lifetime_source, size, size_source,
		 life_stage, life_stage_at, life_source, mass_status, created_at, created_by, modified_at, modified_by)
		VALUES (?, 'wormhole', ?, ?, 'auto', 'auto', 'unknown', 'auto', 1, 1, 'default', 'fresh', 1, 1, 1, 1)`,
		tenant, sigID, system)
	return err
}

func addPair(t *testing.T, db *sqlite.DB, tenant, system int64, code string) (int64, error) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.Writer().BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	sigID, err := insertSignature(ctx, tx, tenant, system, code)
	if err != nil {
		return 0, err
	}
	if err := insertWormhole(ctx, tx, tenant, system, sigID); err != nil {
		return 0, err
	}
	return sigID, tx.Commit()
}

func TestSnapshotConsistent(t *testing.T) {
	db := openSeeded(t)
	reader := sqlite.NewReader(db, nil)
	ctx := context.Background()

	var stop atomic.Bool
	var wg sync.WaitGroup
	writeErr := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; !stop.Load(); i++ {
			code := "S" + time.Now().Format("150405.000000000")
			if _, err := addPair(t, db, 1, int64(30000000+i), code); err != nil {
				writeErr <- err
				return
			}
		}
	}()

	for i := 0; i < 200; i++ {
		snap, err := reader.ReadSnapshot(ctx, 1)
		if err != nil {
			t.Fatalf("snapshot: %v", err)
		}
		sigs := make(map[int64]bool, len(snap.Signatures))
		for _, s := range snap.Signatures {
			sigs[s.ID] = true
		}
		if len(snap.Signatures) != len(snap.Connections) {
			t.Fatalf("snapshot has %d signatures but %d connections", len(snap.Signatures), len(snap.Connections))
		}
		for _, c := range snap.Connections {
			if c.SigAID == nil || !sigs[*c.SigAID] {
				t.Fatalf("connection %d references a signature missing from the snapshot", c.ID)
			}
		}
	}
	stop.Store(true)
	wg.Wait()
	select {
	case err := <-writeErr:
		t.Fatalf("writer: %v", err)
	default:
	}
}

func TestSnapshotTenantIsolation(t *testing.T) {
	db := openSeeded(t)
	reader := sqlite.NewReader(db, nil)
	ctx := context.Background()

	idsA := make([]int64, 0, 3)
	for i, code := range []string{"AAA-001", "AAA-002", "AAA-003"} {
		a, err := addPair(t, db, 1, int64(100+i), code)
		if err != nil {
			t.Fatalf("seed A: %v", err)
		}
		idsA = append(idsA, a)
		if _, err := addPair(t, db, 2, int64(200+i), code); err != nil {
			t.Fatalf("seed B: %v", err)
		}
	}

	snapA, err := reader.ReadSnapshot(ctx, 1)
	if err != nil {
		t.Fatalf("snapshot A: %v", err)
	}
	if len(snapA.Signatures) != len(idsA) || len(snapA.Connections) != len(idsA) {
		t.Fatalf("tenant A got %d signatures, %d connections; want %d each", len(snapA.Signatures), len(snapA.Connections), len(idsA))
	}
	for _, s := range snapA.Signatures {
		if s.TenantID != 1 {
			t.Errorf("tenant A snapshot holds signature %d of tenant %d", s.ID, s.TenantID)
		}
	}
	for _, c := range snapA.Connections {
		if c.TenantID != 1 {
			t.Errorf("tenant A snapshot holds connection %d of tenant %d", c.ID, c.TenantID)
		}
	}

	unknown, err := reader.ReadSnapshot(ctx, 99)
	if err != nil {
		t.Fatalf("snapshot unknown tenant: %v", err)
	}
	if len(unknown.Signatures) != 0 || len(unknown.Connections) != 0 {
		t.Errorf("unknown tenant snapshot not empty")
	}
}

func TestSnapshotLatencyRecorded(t *testing.T) {
	db := openSeeded(t)
	stats := &fakeStats{}
	reader := sqlite.NewReader(db, stats)

	for i := 0; i < 3; i++ {
		if _, err := reader.ReadSnapshot(context.Background(), 1); err != nil {
			t.Fatalf("snapshot: %v", err)
		}
	}
	if got := stats.snapshotCount(); got != 3 {
		t.Fatalf("recorded %d snapshot latencies, want 3", got)
	}
	for _, d := range stats.snapshots {
		if d < 0 {
			t.Errorf("negative latency %v", d)
		}
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := reader.ReadSnapshot(cancelled, 1); err == nil {
		t.Fatal("snapshot with cancelled context succeeded")
	}
	if got := stats.snapshotCount(); got != 3 {
		t.Errorf("failed snapshot recorded a latency: %d", got)
	}
}

var _ store.SnapshotReader = (*sqlite.Reader)(nil)
