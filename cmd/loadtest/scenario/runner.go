package scenario

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/menaceofmorons/ShadowChain/cmd/loadtest/config"
	"github.com/menaceofmorons/ShadowChain/cmd/loadtest/report"
	"github.com/menaceofmorons/ShadowChain/internal/store"
	"github.com/menaceofmorons/ShadowChain/internal/store/sqlite"
)

const (
	shortTenants    = 10
	shortCharacters = 30
	shortDuration   = 3 * time.Second
	shortWindow     = 250 * time.Millisecond
	fullWindow      = time.Second
	shortMaintain   = time.Second
	peakSampleEvery = 100 * time.Millisecond
	stallGap        = 50 * time.Millisecond
	defaultReaders  = 4
	shipTypeID      = 11176
	shipBaseMass    = 1_000_000
)

type Options struct {
	Config           config.Config
	ConfigPath       string
	Duration         time.Duration
	Window           time.Duration
	Readers          int
	TempRoot         string
	MaintenanceEvery time.Duration
	SampleEvery      time.Duration
	WriterStall      time.Duration
}

func FullOptions(cfg config.Config, configPath string) Options {
	return Options{
		Config:           cfg,
		ConfigPath:       configPath,
		Duration:         time.Duration(cfg.Profile.DurationMinutes * float64(time.Minute)),
		Window:           fullWindow,
		Readers:          defaultReaders,
		MaintenanceEvery: sqlite.DefaultMaintenanceInterval,
		SampleEvery:      sqlite.DefaultWALSampleInterval,
	}
}

func ShortOptions(cfg config.Config, configPath string) Options {
	cfg.Profile.Tenants = min(cfg.Profile.Tenants, shortTenants)
	cfg.Profile.Characters = min(cfg.Profile.Characters, shortCharacters)
	cfg.Profile.DurationMinutes = shortDuration.Minutes()
	return Options{
		Config:           cfg,
		ConfigPath:       configPath,
		Duration:         shortDuration,
		Window:           shortWindow,
		Readers:          defaultReaders,
		MaintenanceEvery: shortMaintain,
		SampleEvery:      sqlite.DefaultWALSampleInterval,
	}
}

type Counts struct {
	Pastes              int64 `json:"pastes"`
	PasteLines          int64 `json:"pasteLines"`
	Jumps               int64 `json:"jumps"`
	Patches             int64 `json:"patches"`
	Snapshots           int64 `json:"snapshots"`
	Skipped             int64 `json:"skipped"`
	Busy                int64 `json:"busy"`
	OtherErrors         int64 `json:"otherErrors"`
	MaintenanceFailures int64 `json:"maintenanceFailures"`
	QueueWaitSamples    int64 `json:"queueWaitSamples"`
	WriteLatencySamples int64 `json:"writeLatencySamples"`
	SnapshotSamples     int64 `json:"snapshotSamples"`
}

type Result struct {
	Seed         uint64        `json:"seed"`
	Windows      int           `json:"windows"`
	BurstWindows int           `json:"burstWindows"`
	DataDir      string        `json:"dataDir"`
	Counts       Counts        `json:"counts"`
	FirstError   string        `json:"firstError,omitempty"`
	Report       report.Report `json:"report"`
}

func (r Result) Healthy() bool { return r.Report.Pass && r.Counts.OtherErrors == 0 && r.Counts.MaintenanceFailures == 0 }

type counters struct {
	pastes, pasteLines, jumps, patches, snapshots, skipped, busy, other atomic.Int64
	firstError                                                          atomic.Pointer[string]
}

func (c *counters) classify(err error) {
	switch {
	case err == nil:
	case errors.Is(err, store.ErrVersionConflict), errors.Is(err, store.ErrNotFound):
		c.skipped.Add(1)
	case isBusy(err):
		c.busy.Add(1)
	default:
		c.other.Add(1)
		msg := err.Error()
		c.firstError.CompareAndSwap(nil, &msg)
	}
}

func isBusy(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "database is locked") || strings.Contains(msg, "sqlite_busy")
}

type run struct {
	opts     Options
	db       *sqlite.DB
	store    *sqlite.Store
	reader   *sqlite.Reader
	counters counters
}

func validate(o Options) error {
	if o.Duration <= 0 || o.Window <= 0 {
		return errors.New("scenario: duration and window must be positive")
	}
	if o.Readers < 1 {
		return errors.New("scenario: at least one snapshot reader is required")
	}
	if o.MaintenanceEvery <= 0 || o.SampleEvery <= 0 {
		return errors.New("scenario: maintenance intervals must be positive")
	}
	return o.Config.Validate()
}

func Run(ctx context.Context, opts Options) (Result, error) {
	if err := validate(opts); err != nil {
		return Result{}, err
	}
	dir, err := os.MkdirTemp(opts.TempRoot, "loadtest-")
	if err != nil {
		return Result{}, fmt.Errorf("scenario: temp dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()

	db, err := sqlite.Open(ctx, filepath.Join(dir, "loadtest.db"), sqlite.Options{Sync: sqlite.SyncFromEnv()})
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = db.Close() }()
	if err := seed(ctx, db, opts.Config.Profile); err != nil {
		return Result{}, err
	}

	stats := sqlite.NewStats()
	st := sqlite.NewStore(db, stats)
	r := &run{opts: opts, db: db, store: st, reader: sqlite.NewReader(db, stats)}
	result, err := r.execute(ctx, stats)
	st.Close()
	if err != nil {
		return Result{}, err
	}
	result.DataDir = dir
	return result, nil
}

func seed(ctx context.Context, db *sqlite.DB, p config.Profile) error {
	if err := sqlite.ApplyTestSchema(ctx, db.Writer()); err != nil {
		return err
	}
	for t := 1; t <= p.Tenants; t++ {
		if _, err := db.Writer().ExecContext(ctx, `INSERT INTO tenant (id) VALUES (?)`, t); err != nil {
			return fmt.Errorf("scenario: seed tenant: %w", err)
		}
	}
	warm := sqlite.NewStore(db, sqlite.NewStats())
	defer warm.Close()
	for t := 1; t <= p.Tenants; t++ {
		cmd := store.PasteCommand{
			SystemID: SystemFor(t, 0),
			Actor:    store.Actor{CharacterID: CharacterID(t), Name: characterName(t)},
			Lines:    WarmupPaste(),
		}
		if _, err := warm.ApplyPaste(ctx, TenantID(t), cmd); err != nil {
			return fmt.Errorf("scenario: warm-up paste: %w", err)
		}
	}
	return nil
}

func characterName(c int) string { return fmt.Sprintf("Pilot %d", c) }

func (r *run) execute(ctx context.Context, stats *sqlite.Stats) (Result, error) {
	p := r.opts.Config.Profile
	windows := int((r.opts.Duration + r.opts.Window - 1) / r.opts.Window)
	plan := BuildPlan(p, windows)

	helpers, stopHelpers := context.WithCancel(ctx)
	var helperWG sync.WaitGroup
	maint := sqlite.NewMaintenance(r.db, stats)
	var peak atomic.Int64
	helperWG.Go(func() { _ = maint.Run(helpers, r.opts.MaintenanceEvery, r.opts.SampleEvery) })
	helperWG.Go(func() { samplePeak(helpers, maint, &peak) })
	if r.opts.WriterStall > 0 {
		helperWG.Go(func() { stallWriter(helpers, r.db, r.opts.WriterStall) })
	}

	burstWindows := 0
	for _, w := range plan {
		if w.Burst {
			burstWindows++
		}
		if err := r.runWindow(ctx, w); err != nil {
			stopHelpers()
			helperWG.Wait()
			return Result{}, err
		}
	}
	stopHelpers()
	helperWG.Wait()

	if _, err := maint.Checkpoint(ctx); err != nil {
		return Result{}, err
	}
	postCheckpoint, err := maint.SampleWAL()
	if err != nil {
		return Result{}, err
	}

	m := report.FromStats(stats, postCheckpoint, r.counters.busy.Load())
	m.WALPeakBytes = peak.Load()
	counts := r.snapshotCounts(m)
	var maintErr error
	counts.MaintenanceFailures, maintErr = maint.Failures()
	res := Result{
		Seed:         p.Seed,
		Windows:      windows,
		BurstWindows: burstWindows,
		Counts:       counts,
		Report:       report.Evaluate(r.opts.Config, r.opts.ConfigPath, m),
	}
	if msg := r.counters.firstError.Load(); msg != nil {
		res.FirstError = *msg
	} else if maintErr != nil {
		res.FirstError = maintErr.Error()
	}
	return res, nil
}

func (r *run) snapshotCounts(m report.Measurements) Counts {
	c := &r.counters
	return Counts{
		Pastes: c.pastes.Load(), PasteLines: c.pasteLines.Load(), Jumps: c.jumps.Load(), Patches: c.patches.Load(),
		Snapshots: c.snapshots.Load(), Skipped: c.skipped.Load(), Busy: c.busy.Load(), OtherErrors: c.other.Load(),
		QueueWaitSamples: m.QueueWait.Count, WriteLatencySamples: m.WriteLatency.Count, SnapshotSamples: m.SnapshotLatency.Count,
	}
}

func samplePeak(ctx context.Context, m *sqlite.Maintenance, peak *atomic.Int64) {
	tick := time.NewTicker(peakSampleEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if size, err := m.SampleWAL(); err == nil && size > peak.Load() {
				peak.Store(size)
			}
		}
	}
}

func stallWriter(ctx context.Context, db *sqlite.DB, stall time.Duration) {
	for sleepCtx(ctx, stallGap) {
		conn, err := db.Writer().Conn(ctx)
		if err != nil {
			return
		}
		alive := sleepCtx(ctx, stall)
		_ = conn.Close()
		if !alive {
			return
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func (r *run) runWindow(ctx context.Context, w Window) error {
	start := time.Now()
	var background, pastes sync.WaitGroup
	for _, op := range w.Background {
		background.Go(func() { r.runOp(ctx, op) })
	}
	burstDone := make(chan struct{})
	if w.Burst {
		for i := range r.opts.Readers {
			background.Go(func() { r.readDuringBurst(ctx, w, i, burstDone) })
		}
	}
	for _, op := range w.Pastes {
		pastes.Go(func() { r.runOp(ctx, op) })
	}
	pastes.Wait()
	close(burstDone)
	background.Wait()
	if err := ctx.Err(); err != nil {
		return err
	}
	if rest := r.opts.Window - time.Since(start); rest > 0 {
		sleepCtx(ctx, rest)
	}
	return ctx.Err()
}

func (r *run) readDuringBurst(ctx context.Context, w Window, worker int, done <-chan struct{}) {
	rng := newRand(r.opts.Config.Profile.Seed + uint64(w.Index)*1000 + uint64(worker) + 1)
	for {
		select {
		case <-done:
			return
		default:
		}
		tenant := w.Pastes[rng.IntN(len(w.Pastes))].Tenant
		_, err := r.reader.ReadSnapshot(ctx, TenantID(tenant))
		r.counters.snapshots.Add(1)
		r.counters.classify(err)
	}
}

func (r *run) runOp(ctx context.Context, op Op) {
	actor := store.Actor{CharacterID: CharacterID(op.Character), Name: characterName(op.Character)}
	switch op.Kind {
	case OpPaste:
		_, err := r.store.ApplyPaste(ctx, TenantID(op.Tenant), store.PasteCommand{SystemID: op.System, Actor: actor, Lines: op.Lines})
		r.counters.pastes.Add(1)
		r.counters.pasteLines.Add(int64(len(op.Lines)))
		r.counters.classify(err)
	case OpJump:
		r.runJump(ctx, op, actor)
	case OpPatch:
		r.runPatch(ctx, op, actor)
	}
}

func (r *run) runJump(ctx context.Context, op Op, actor store.Actor) {
	var connectionID int64
	err := r.db.Reader().QueryRowContext(ctx,
		`SELECT id FROM connection WHERE tenant_id = ? ORDER BY id LIMIT 1 OFFSET ?`,
		op.Tenant, op.Pick).Scan(&connectionID)
	if errors.Is(err, sql.ErrNoRows) {
		r.counters.skipped.Add(1)
		return
	}
	if err != nil {
		r.counters.classify(err)
		return
	}
	err = r.store.LogJump(ctx, TenantID(op.Tenant), actor, store.JumpEntry{
		ConnectionID:  connectionID,
		CharacterID:   actor.CharacterID,
		CharacterName: actor.Name,
		ShipTypeID:    shipTypeID,
		BaseMass:      shipBaseMass,
		EffectiveMass: shipBaseMass,
		FromSystemID:  op.System,
		Source:        "tracked",
	})
	r.counters.jumps.Add(1)
	r.counters.classify(err)
}

func (r *run) runPatch(ctx context.Context, op Op, actor store.Actor) {
	var id, version int64
	err := r.db.Reader().QueryRowContext(ctx,
		`SELECT id, version FROM signature WHERE tenant_id = ? ORDER BY id LIMIT 1 OFFSET ?`,
		op.Tenant, op.Pick).Scan(&id, &version)
	if errors.Is(err, sql.ErrNoRows) {
		r.counters.skipped.Add(1)
		return
	}
	if err != nil {
		r.counters.classify(err)
		return
	}
	name := fmt.Sprintf("Scanned by %d", op.Character)
	_, err = r.store.PatchSignature(ctx, TenantID(op.Tenant), id, actor, store.SignaturePatch{ExpectedVersion: version, SiteName: &name})
	r.counters.patches.Add(1)
	r.counters.classify(err)
}
