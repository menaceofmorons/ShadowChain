package sqlite

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const (
	DefaultMaintenanceInterval = 5 * time.Minute
	DefaultWALSampleInterval   = 10 * time.Second
)

type CheckpointResult struct {
	Busy         bool
	LogFrames    int64
	Checkpointed int64
}

type Maintenance struct {
	db    *DB
	stats store.StatsRecorder
}

func NewMaintenance(db *DB, stats store.StatsRecorder) *Maintenance {
	return &Maintenance{db: db, stats: stats}
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
	if _, err := m.db.Writer().ExecContext(ctx, "PRAGMA optimize"); err != nil {
		return fmt.Errorf("sqlite: optimize: %w", err)
	}
	return nil
}

func (m *Maintenance) Checkpoint(ctx context.Context) (CheckpointResult, error) {
	var busy int
	var res CheckpointResult
	row := m.db.Writer().QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)")
	if err := row.Scan(&busy, &res.LogFrames, &res.Checkpointed); err != nil {
		return CheckpointResult{}, fmt.Errorf("sqlite: wal checkpoint: %w", err)
	}
	res.Busy = busy != 0
	return res, nil
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
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-sample.C:
			_, _ = m.SampleWAL()
		case <-maintenance.C:
			_ = m.RunOnce(ctx)
		}
	}
}
