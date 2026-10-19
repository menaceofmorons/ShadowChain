package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const (
	DefaultMaintenanceInterval = 5 * time.Minute
	DefaultWALSampleInterval   = 10 * time.Second

	// TUNE: longest the TRUNCATE checkpoint may hold the writer queue waiting for readers; a few busy-handler polls.
	CheckpointMaxWait = 100 * time.Millisecond
	// TUNE: delay before retrying a busy TRUNCATE checkpoint; short enough to clear the WAL soon after readers release.
	DefaultCheckpointRetryInterval = 10 * time.Second
)

type CheckpointResult struct {
	Busy         bool
	LogFrames    int64
	Checkpointed int64
}

type Maintenance struct {
	store *Store
	db    *DB
	stats store.StatsRecorder

	mu        sync.Mutex
	failures  int64
	lastError error

	busyCheckpoints int64
	truncatePending bool
	checkpointRetry time.Duration
}

func (m *Maintenance) WithCheckpointRetry(d time.Duration) *Maintenance {
	m.mu.Lock()
	m.checkpointRetry = d
	m.mu.Unlock()
	return m
}

func (m *Maintenance) BusyCheckpoints() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.busyCheckpoints
}

func (m *Maintenance) recordCheckpoint(busy bool) {
	m.mu.Lock()
	m.truncatePending = busy
	if busy {
		m.busyCheckpoints++
	}
	m.mu.Unlock()
}

func (m *Maintenance) retryState() (pending bool, every time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.truncatePending, m.checkpointRetry
}

func (m *Maintenance) Failures() (count int64, last error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.failures, m.lastError
}

func (m *Maintenance) recordFailure(err error) {
	if err == nil {
		return
	}
	m.mu.Lock()
	m.failures++
	m.lastError = err
	m.mu.Unlock()
}

func NewMaintenance(st *Store, stats store.StatsRecorder) *Maintenance {
	return &Maintenance{store: st, db: st.db, stats: stats, checkpointRetry: DefaultCheckpointRetryInterval}
}

func (m *Maintenance) SampleWAL() (int64, error) {
	info, err := os.Stat(m.db.Path() + "-wal")
	size := int64(0)
	switch {
	case err == nil:
		size = info.Size()
	case !errors.Is(err, os.ErrNotExist):
		return 0, fmt.Errorf("sqlite: stat wal: %w", err)
	}
	if m.stats != nil {
		m.stats.RecordWALSize(size)
	}
	return size, nil
}

func (m *Maintenance) Optimize(ctx context.Context) error {
	err := m.store.executeExclusive(ctx, func(ctx context.Context, conn *sql.DB) error {
		_, err := conn.ExecContext(ctx, "PRAGMA optimize")
		return err
	})
	if err != nil {
		return fmt.Errorf("sqlite: optimize: %w", err)
	}
	return nil
}

func (m *Maintenance) Checkpoint(ctx context.Context) (CheckpointResult, error) {
	var res CheckpointResult
	err := m.store.executeExclusive(ctx, func(ctx context.Context, conn *sql.DB) error {
		var err error
		res, err = boundedCheckpoint(ctx, conn)
		return err
	})
	if err != nil {
		return CheckpointResult{}, fmt.Errorf("sqlite: wal checkpoint: %w", err)
	}
	m.recordCheckpoint(res.Busy)
	return res, nil
}

func boundedCheckpoint(ctx context.Context, db *sql.DB) (CheckpointResult, error) {
	var res CheckpointResult
	conn, err := db.Conn(ctx)
	if err != nil {
		return res, err
	}
	defer func() { _ = conn.Close() }()

	var busy int
	if err := conn.QueryRowContext(ctx, "PRAGMA wal_checkpoint(PASSIVE)").Scan(&busy, &res.LogFrames, &res.Checkpointed); err != nil {
		return res, err
	}
	if err := setBusyTimeout(ctx, conn, CheckpointMaxWait.Milliseconds()); err != nil {
		return res, err
	}
	defer func() { _ = setBusyTimeout(context.Background(), conn, BusyTimeoutMillis) }()
	if err := conn.QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &res.LogFrames, &res.Checkpointed); err != nil {
		return res, err
	}
	res.Busy = busy != 0
	return res, nil
}

func setBusyTimeout(ctx context.Context, conn *sql.Conn, millis int64) error {
	_, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA busy_timeout = %d", millis))
	return err
}

func (m *Maintenance) RunOnce(ctx context.Context) error {
	return errors.Join(m.Optimize(ctx), m.checkpointAndSample(ctx))
}

func (m *Maintenance) checkpointAndSample(ctx context.Context) error {
	_, cpErr := m.Checkpoint(ctx)
	_, sampleErr := m.SampleWAL()
	return errors.Join(cpErr, sampleErr)
}

func (m *Maintenance) Run(ctx context.Context, maintenanceEvery, sampleEvery time.Duration) error {
	if maintenanceEvery <= 0 || sampleEvery <= 0 {
		return errors.New("sqlite: maintenance intervals must be positive")
	}
	maintenance := time.NewTicker(maintenanceEvery)
	defer maintenance.Stop()
	sample := time.NewTicker(sampleEvery)
	defer sample.Stop()
	_, retryEvery := m.retryState()
	if retryEvery <= 0 {
		return errors.New("sqlite: checkpoint retry interval must be positive")
	}
	retry := time.NewTicker(retryEvery)
	defer retry.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-retry.C:
			if pending, _ := m.retryState(); pending {
				_, err := m.Checkpoint(ctx)
				if ctx.Err() == nil {
					m.recordFailure(err)
				}
			}
		case <-sample.C:
			_, err := m.SampleWAL()
			m.recordFailure(err)
		case <-maintenance.C:
			if err := m.RunOnce(ctx); ctx.Err() == nil {
				m.recordFailure(err)
			}
		}
	}
}
