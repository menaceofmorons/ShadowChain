package report

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/menaceofmorons/ShadowChain/cmd/loadtest/config"
	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const cfgPath = "../contention.config.json"

func defaults(t *testing.T) config.Config {
	t.Helper()
	cfg, err := config.Load(cfgPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func passing() Measurements {
	return Measurements{
		QueueWait:       store.LatencySummary{P99: 50 * time.Millisecond, Max: 249 * time.Millisecond},
		WriteLatency:    store.LatencySummary{P95: 100 * time.Millisecond},
		SnapshotLatency: store.LatencySummary{P95: 500 * time.Millisecond},
		WALPeakBytes:    256 * bytesPerMB, WALPostCheckpointBytes: 64 * bytesPerMB,
	}
}

func TestEvaluateTable(t *testing.T) {
	ms := time.Millisecond
	tests := []struct {
		name   string
		mutate func(*Measurements)
		idx    int
		pass   bool
	}{
		{"queue p99 at threshold", func(m *Measurements) {}, 0, true},
		{"queue p99 over", func(m *Measurements) { m.QueueWait.P99 = 50*ms + 1 }, 0, false},
		{"queue p99 under", func(m *Measurements) { m.QueueWait.P99 = 10 * ms }, 0, true},
		{"queue max just under", func(m *Measurements) {}, 1, true},
		{"queue max exactly at threshold fails", func(m *Measurements) { m.QueueWait.Max = 250 * ms }, 1, false},
		{"queue max over", func(m *Measurements) { m.QueueWait.Max = 300 * ms }, 1, false},
		{"write p95 at threshold", func(m *Measurements) {}, 2, true},
		{"write p95 over", func(m *Measurements) { m.WriteLatency.P95 = 100*ms + 1 }, 2, false},
		{"snapshot p95 at threshold", func(m *Measurements) {}, 3, true},
		{"snapshot p95 over", func(m *Measurements) { m.SnapshotLatency.P95 = 501 * ms }, 3, false},
		{"wal peak at threshold", func(m *Measurements) {}, 4, true},
		{"wal peak over", func(m *Measurements) { m.WALPeakBytes = 256*bytesPerMB + 1 }, 4, false},
		{"wal post at threshold", func(m *Measurements) {}, 5, true},
		{"wal post over", func(m *Measurements) { m.WALPostCheckpointBytes = 64*bytesPerMB + 1 }, 5, false},
		{"busy zero", func(m *Measurements) {}, 6, true},
		{"busy one", func(m *Measurements) { m.BusyErrors = 1 }, 6, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := passing()
			tc.mutate(&m)
			r := Evaluate(defaults(t), cfgPath, m)
			if len(r.Results) != 7 {
				t.Fatalf("results = %d", len(r.Results))
			}
			if got := r.Results[tc.idx].Pass; got != tc.pass {
				t.Fatalf("%s pass = %v, want %v", r.Results[tc.idx].Metric, got, tc.pass)
			}
			if r.Pass != tc.pass {
				t.Fatalf("overall = %v, want %v", r.Pass, tc.pass)
			}
		})
	}
}

func TestEvaluateFollowsOverride(t *testing.T) {
	cfg := defaults(t)
	m := passing()
	m.SnapshotLatency.P95 = 400 * time.Millisecond
	if !Evaluate(cfg, cfgPath, m).Pass {
		t.Fatal("should pass at default")
	}
	if err := cfg.Set("thresholds.snapshotP95Ms=300"); err != nil {
		t.Fatal(err)
	}
	if Evaluate(cfg, cfgPath, m).Pass {
		t.Fatal("should fail at tightened threshold")
	}
}

func TestReportListsThresholdsUsed(t *testing.T) {
	cfg := defaults(t)
	if err := cfg.Set("thresholds.writeLatencyP95Ms=77"); err != nil {
		t.Fatal(err)
	}
	m := passing()
	m.WriteLatency.P95 = 90 * time.Millisecond
	r := Evaluate(cfg, cfgPath, m)

	var text bytes.Buffer
	if err := r.WriteText(&text); err != nil {
		t.Fatal(err)
	}
	out := text.String()
	for _, want := range []string{cfgPath, "Writer queue wait p99", "Writer queue wait max", "Write latency p95", "Snapshot p95", "WAL size peak", "TRUNCATE", "SQLITE_BUSY", "<= 77 ms", "measured 90.000 ms", "FAIL", "Verdict: FAIL", "tenants=100", "seed=1"} {
		if !strings.Contains(out, want) {
			t.Errorf("text report missing %q:\n%s", want, out)
		}
	}

	var js bytes.Buffer
	if err := r.WriteJSON(&js); err != nil {
		t.Fatal(err)
	}
	var back Report
	if err := json.Unmarshal(js.Bytes(), &back); err != nil {
		t.Fatal(err)
	}
	if back.ConfigPath != cfgPath || back.Pass || len(back.Results) != 7 || back.Config.Thresholds.WriteLatencyP95Ms != 77 {
		t.Fatalf("json report: %+v", back)
	}
	if back.Results[2].Threshold != 77 || back.Results[2].Measured != 90 || back.Results[2].Pass {
		t.Fatalf("json result: %+v", back.Results[2])
	}
}
