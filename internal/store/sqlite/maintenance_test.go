package sqlite_test

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/menaceofmorons/ShadowChain/internal/store/sqlite"
)

func writeBulk(t *testing.T, db *sqlite.DB, from, n int) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.Writer().BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	for i := from; i < from+n; i++ {
		if _, err := insertSignature(ctx, tx, 1, int64(i), fmt.Sprintf("B%06d", i)); err != nil {
			_ = tx.Rollback()
			t.Fatalf("insert: %v", err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func newMaintenance(t *testing.T, db *sqlite.DB, stats *fakeStats) *sqlite.Maintenance {
	t.Helper()
	st := sqlite.NewStore(db, stats)
	t.Cleanup(st.Close)
	return sqlite.NewMaintenance(st, stats)
}

func TestCheckpointBusyThenSucceedsThroughQueue(t *testing.T) {
	db := openSeeded(t)
	stats := &fakeStats{}
	m := newMaintenance(t, db, stats)
	ctx := context.Background()

	writeBulk(t, db, 0, 50)
	conn, err := db.Reader().Conn(ctx)
	if err != nil {
		t.Fatalf("reader conn: %v", err)
	}
	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		t.Fatalf("begin: %v", err)
	}
	var n int
	if err := conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM signature").Scan(&n); err != nil {
		t.Fatalf("read: %v", err)
	}
	writeBulk(t, db, 1000, 5)

	before := stats.queueWaitCount()
	busy, err := m.Checkpoint(ctx)
	if err != nil {
		t.Fatalf("checkpoint while reader open: %v", err)
	}
	if !busy.Busy {
		t.Fatal("checkpoint not busy while a reader holds a WAL snapshot")
	}

	if _, err := conn.ExecContext(ctx, "ROLLBACK"); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("close conn: %v", err)
	}
	ok, err := m.Checkpoint(ctx)
	if err != nil {
		t.Fatalf("checkpoint after reader closed: %v", err)
	}
	if ok.Busy {
		t.Fatal("checkpoint still busy after reader closed")
	}
	if got := stats.queueWaitCount() - before; got != 2 {
		t.Errorf("checkpoints recorded %d queue waits, want 2", got)
	}
}

func TestWALSampling(t *testing.T) {
	db := openSeeded(t)
	stats := &fakeStats{}
	m := newMaintenance(t, db, stats)

	writeBulk(t, db, 0, 200)
	grown, err := m.SampleWAL()
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	if grown <= 0 {
		t.Fatalf("WAL size %d after writes, want > 0", grown)
	}
	if got := stats.lastWAL(); got != grown {
		t.Errorf("recorded WAL size %d, sampled %d", got, grown)
	}

	res, err := m.Checkpoint(context.Background())
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if res.Busy {
		t.Fatal("checkpoint reported busy with no readers")
	}
	after, err := m.SampleWAL()
	if err != nil {
		t.Fatalf("sample after checkpoint: %v", err)
	}
	if after != 0 {
		t.Errorf("WAL size %d after TRUNCATE checkpoint, want 0", after)
	}
	if after >= grown {
		t.Errorf("WAL did not shrink: %d -> %d", grown, after)
	}
}

func TestCheckpointNotStarvedByReaders(t *testing.T) {
	db := openSeeded(t)
	reader := sqlite.NewReader(db, nil)
	m := newMaintenance(t, db, &fakeStats{})
	ctx := context.Background()

	var stop atomic.Bool
	var wg sync.WaitGroup
	for i := 0; i < sqlite.MinReadPool; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for !stop.Load() {
				if _, err := reader.ReadSnapshot(ctx, 1); err != nil {
					return
				}
			}
		}()
	}

	writeBulk(t, db, 0, 200)
	deadline := time.Now().Add(10 * time.Second)
	var res sqlite.CheckpointResult
	for {
		var err error
		res, err = m.Checkpoint(ctx)
		if err != nil {
			t.Fatalf("checkpoint: %v", err)
		}
		if !res.Busy || time.Now().After(deadline) {
			break
		}
		writeBulk(t, db, 1000+int(time.Now().UnixNano()%100000), 1)
	}
	stop.Store(true)
	wg.Wait()

	if res.Busy {
		t.Fatal("checkpoint starved by short snapshot readers")
	}
	if _, err := m.Checkpoint(ctx); err != nil {
		t.Fatalf("final checkpoint: %v", err)
	}
	size, err := m.SampleWAL()
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	if size != 0 {
		t.Errorf("WAL size %d after checkpoint with readers stopped, want 0", size)
	}
}

func TestMaintenanceRunOnce(t *testing.T) {
	db := openSeeded(t)
	stats := &fakeStats{}
	m := newMaintenance(t, db, stats)

	writeBulk(t, db, 0, 50)
	if err := m.RunOnce(context.Background()); err != nil {
		t.Fatalf("run once: %v", err)
	}
	if got := stats.lastWAL(); got != 0 {
		t.Errorf("WAL size %d after RunOnce, want 0", got)
	}
}

func TestMaintenanceRunStopsOnCancel(t *testing.T) {
	db := openSeeded(t)
	stats := &fakeStats{}
	m := newMaintenance(t, db, stats)

	if err := m.Run(context.Background(), 0, time.Second); err == nil {
		t.Fatal("Run accepted a zero interval")
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.Run(ctx, time.Hour, 10*time.Millisecond) }()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after cancel")
	}
	stats.mu.Lock()
	defer stats.mu.Unlock()
	if len(stats.walSizes) == 0 {
		t.Error("Run recorded no WAL samples")
	}
}

func TestMaintenanceFailuresSurfaced(t *testing.T) {
	db := openSeeded(t)
	m := newMaintenance(t, db, &fakeStats{})
	if n, last := m.Failures(); n != 0 || last != nil {
		t.Fatalf("fresh failures = %d, %v", n, last)
	}

	runCtx, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = m.Run(runCtx, 5*time.Millisecond, time.Hour)
	}()
	_ = db.Close()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if n, _ := m.Failures(); n > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop()
	<-done
	if n, last := m.Failures(); n == 0 || last == nil {
		t.Fatalf("Run did not record failures: %d, %v", n, last)
	}
}
