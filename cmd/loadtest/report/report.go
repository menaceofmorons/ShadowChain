package report

import (
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/menaceofmorons/ShadowChain/cmd/loadtest/config"
	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const bytesPerMB = 1024 * 1024

type Measurements struct {
	QueueWait              store.LatencySummary
	WriteLatency           store.LatencySummary
	SnapshotLatency        store.LatencySummary
	WALPeakBytes           int64
	WALPostCheckpointBytes int64
	BusyErrors             int64
}

func FromStats(s store.StatsReader, walPeakBytes, walPostCheckpointBytes, busyErrors int64) Measurements {
	return Measurements{
		QueueWait:              s.QueueWait(),
		WriteLatency:           s.WriteLatency(),
		SnapshotLatency:        s.SnapshotLatency(),
		WALPeakBytes:           walPeakBytes,
		WALPostCheckpointBytes: walPostCheckpointBytes,
		BusyErrors:             busyErrors,
	}
}

type MetricResult struct {
	Metric    string  `json:"metric"`
	Key       string  `json:"key"`
	Unit      string  `json:"unit"`
	Operator  string  `json:"operator"`
	Measured  float64 `json:"measured"`
	Threshold float64 `json:"threshold"`
	Pass      bool    `json:"pass"`
}

type Report struct {
	ConfigPath string         `json:"configPath"`
	Config     config.Config  `json:"config"`
	Results    []MetricResult `json:"results"`
	Pass       bool           `json:"pass"`
}

func ms(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

func Evaluate(cfg config.Config, configPath string, m Measurements) Report {
	t := cfg.Thresholds
	results := []MetricResult{
		latency("Writer queue wait p99", "thresholds.writerQueueWaitP99Ms", m.QueueWait.P99, t.WriterQueueWaitP99Ms, false),
		latency("Writer queue wait max", "thresholds.writerQueueWaitMaxMs", m.QueueWait.Max, t.WriterQueueWaitMaxMs, true),
		latency("Write latency p95", "thresholds.writeLatencyP95Ms", m.WriteLatency.P95, t.WriteLatencyP95Ms, false),
		latency("Snapshot p95 during paste bursts", "thresholds.snapshotP95Ms", m.SnapshotLatency.P95, t.SnapshotP95Ms, false),
		size("WAL size peak", "thresholds.walPeakMB", m.WALPeakBytes, t.WALPeakMB),
		size("WAL size after TRUNCATE checkpoint", "thresholds.walPostCheckpointMB", m.WALPostCheckpointBytes, t.WALPostCheckpointMB),
		{
			Metric: "Failed or SQLITE_BUSY transactions", Key: "thresholds.busyErrors", Unit: "count", Operator: "<=",
			Measured: float64(m.BusyErrors), Threshold: float64(t.BusyErrors), Pass: m.BusyErrors <= t.BusyErrors,
		},
	}
	pass := true
	for _, r := range results {
		pass = pass && r.Pass
	}
	return Report{ConfigPath: configPath, Config: cfg, Results: results, Pass: pass}
}

func latency(metric, key string, measured time.Duration, thresholdMs float64, strict bool) MetricResult {
	limit := time.Duration(thresholdMs * float64(time.Millisecond))
	op, pass := "<=", measured <= limit
	if strict {
		op, pass = "<", measured < limit
	}
	return MetricResult{Metric: metric, Key: key, Unit: "ms", Operator: op, Measured: ms(measured), Threshold: thresholdMs, Pass: pass}
}

func size(metric, key string, bytes int64, thresholdMB float64) MetricResult {
	return MetricResult{
		Metric: metric, Key: key, Unit: "MB", Operator: "<=",
		Measured: float64(bytes) / bytesPerMB, Threshold: thresholdMB, Pass: float64(bytes) <= thresholdMB*bytesPerMB,
	}
}

func verdict(pass bool) string {
	if pass {
		return "PASS"
	}
	return "FAIL"
}

func (r Report) WriteText(w io.Writer) error {
	p := r.Config.Profile
	if _, err := fmt.Fprintf(w, "Config: %s (version %d)\nProfile: tenants=%d characters=%d durationMinutes=%g burstShare=%g pasteSize=%d-%d rarePasteSize=%d-%d rarePasteShare=%g seed=%d windowMillis=%d burstEveryWindows=%d backgroundOpChance=%g jumpShare=%g snapshotsPerSecond=%g\n\n",
		r.ConfigPath, r.Config.Version, p.Tenants, p.Characters, p.DurationMinutes, p.BurstShare,
		p.PasteSizeMin, p.PasteSizeMax, p.RarePasteSizeMin, p.RarePasteSizeMax, p.RarePasteShare, p.Seed,
		p.WindowMillis, p.BurstEveryWindows, p.BackgroundOpChance, p.JumpShare, p.SnapshotsPerSecond); err != nil {
		return err
	}
	for _, m := range r.Results {
		if _, err := fmt.Fprintf(w, "%-4s %-36s measured %.3f %s, threshold %s %g %s (%s)\n",
			verdict(m.Pass), m.Metric, m.Measured, m.Unit, m.Operator, m.Threshold, m.Unit, m.Key); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintf(w, "\nVerdict: %s\n", verdict(r.Pass))
	return err
}

func (r Report) WriteJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(r)
}
