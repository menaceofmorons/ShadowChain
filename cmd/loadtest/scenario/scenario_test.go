package scenario

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/menaceofmorons/ShadowChain/cmd/loadtest/config"
	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const defaultConfig = "../contention.config.json"

func loadDefault(t *testing.T) config.Config {
	t.Helper()
	cfg, err := config.Load(defaultConfig, nil)
	if err != nil {
		t.Fatalf("load default config: %v", err)
	}
	return cfg
}

func shortTestOptions(t *testing.T) Options {
	t.Helper()
	opts := ShortOptions(loadDefault(t), defaultConfig)
	opts.Duration = 1500 * time.Millisecond
	opts.TempRoot = t.TempDir()
	return opts
}

func TestScenarioDeterministicWorkload(t *testing.T) {
	p := loadDefault(t).Profile
	a, b := BuildPlan(p, 20), BuildPlan(p, 20)
	if !reflect.DeepEqual(a, b) {
		t.Fatal("same seed produced different plans")
	}
	p.Seed++
	if reflect.DeepEqual(a, BuildPlan(p, 20)) {
		t.Fatal("different seed produced the same plan")
	}
}

func TestBurstShareRespected(t *testing.T) {
	p := loadDefault(t).Profile
	want := BurstTenantCount(p)
	if want != 20 {
		t.Fatalf("burst tenants = %d, want 20 for 100 tenants at 0.2", want)
	}
	rare := 0
	total := 0
	for _, w := range BuildPlan(p, 200) {
		if w.Burst != (w.Index%p.BurstEveryWindows == 0) {
			t.Fatalf("window %d burst flag = %v", w.Index, w.Burst)
		}
		if !w.Burst {
			if len(w.Pastes) != 1 {
				t.Fatalf("quiet window %d pastes = %d, want 1", w.Index, len(w.Pastes))
			}
			continue
		}
		if len(w.Pastes) != want {
			t.Fatalf("burst window %d pastes = %d, want %d", w.Index, len(w.Pastes), want)
		}
		seen := map[int]bool{}
		for _, op := range w.Pastes {
			if seen[op.Tenant] || op.Tenant < 1 || op.Tenant > p.Tenants {
				t.Fatalf("window %d: bad or duplicate tenant %d", w.Index, op.Tenant)
			}
			seen[op.Tenant] = true
			n := len(op.Lines)
			switch {
			case n >= p.PasteSizeMin && n <= p.PasteSizeMax:
			case n >= p.RarePasteSizeMin && n <= p.RarePasteSizeMax:
				rare++
			default:
				t.Fatalf("paste size %d outside configured ranges", n)
			}
			total++
		}
	}
	if rare == 0 || rare > total/5 {
		t.Fatalf("rare pastes = %d of %d, want a small non-zero share", rare, total)
	}
}

func TestBuildPlanCommandKinds(t *testing.T) {
	plan := BuildPlan(loadDefault(t).Profile, 5)
	kinds := map[OpKind]int{}
	for _, w := range plan {
		for _, op := range append(append([]Op{}, w.Pastes...), w.Background...) {
			kinds[op.Kind]++
		}
	}
	for _, k := range []OpKind{OpPaste, OpJump, OpPatch} {
		if kinds[k] == 0 {
			t.Fatalf("no %s commands in plan: %v", k, kinds)
		}
	}
}

func TestBackgroundOpsSpreadAcrossWindow(t *testing.T) {
	p := loadDefault(t).Profile
	buckets := make([]int, 4)
	total := 0
	for _, w := range BuildPlan(p, 20) {
		for _, op := range w.Background {
			if op.Offset < 0 || op.Offset >= 1 {
				t.Fatalf("offset %v outside [0, 1)", op.Offset)
			}
			buckets[int(op.Offset*float64(len(buckets)))]++
			total++
		}
		for _, op := range w.Pastes {
			if op.Offset != 0 {
				t.Fatalf("burst paste has offset %v, want simultaneous start", op.Offset)
			}
		}
	}
	for i, n := range buckets {
		if n < total/8 {
			t.Fatalf("quarter %d holds %d of %d background ops; offsets are not spread", i, n, total)
		}
	}
}

func TestScenarioShortProfileRuns(t *testing.T) {
	res, err := Run(context.Background(), shortTestOptions(t))
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Counts.OtherErrors != 0 {
		t.Fatalf("unexpected errors: %d (%s)", res.Counts.OtherErrors, res.FirstError)
	}
	if res.Counts.Pastes == 0 || res.Counts.Jumps == 0 || res.Counts.Snapshots == 0 {
		t.Fatalf("workload did not run: %+v", res.Counts)
	}
	if res.Counts.QueueWaitSamples == 0 || res.Counts.SnapshotSamples == 0 {
		t.Fatalf("no samples recorded: %+v", res.Counts)
	}
	if res.Seed != 1 || len(res.Report.Results) != 7 {
		t.Fatalf("seed = %d, results = %d", res.Seed, len(res.Report.Results))
	}
	var text, js bytes.Buffer
	if err := res.WriteText(&text); err != nil {
		t.Fatal(err)
	}
	if err := res.WriteJSON(&js); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Verdict:", "Seed: 1", "queueWait="} {
		if !strings.Contains(text.String(), want) {
			t.Fatalf("report text missing %q:\n%s", want, text.String())
		}
	}
	if !strings.Contains(js.String(), `"seed": 1`) {
		t.Fatalf("json missing seed:\n%s", js.String())
	}
}

func TestScenarioUsesTempDataDir(t *testing.T) {
	opts := shortTestOptions(t)
	opts.Duration = 500 * time.Millisecond
	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if filepath.Dir(res.DataDir) != opts.TempRoot {
		t.Fatalf("data dir %q not under temp root %q", res.DataDir, opts.TempRoot)
	}
	if _, err := os.Stat(res.DataDir); !os.IsNotExist(err) {
		t.Fatalf("data dir still present after run: %v", err)
	}
	entries, err := os.ReadDir(opts.TempRoot)
	if err != nil || len(entries) != 0 {
		t.Fatalf("temp root not clean: %v %v", entries, err)
	}
}

func TestScenarioFailsOnInjectedSlowWriter(t *testing.T) {
	opts := shortTestOptions(t)
	opts.Duration = 2 * time.Second
	opts.WriterStall = 400 * time.Millisecond
	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Report.Pass {
		t.Fatalf("slow writer passed the verdict: %+v", res.Report.Results)
	}
	failed := false
	for _, m := range res.Report.Results {
		if m.Key == "thresholds.writerQueueWaitMaxMs" && !m.Pass {
			failed = true
		}
	}
	if !failed {
		t.Fatalf("queue wait max did not fail: %+v", res.Report.Results)
	}
}

func TestRunRejectsInvalidOptions(t *testing.T) {
	opts := shortTestOptions(t)
	opts.Duration = 0
	if _, err := Run(context.Background(), opts); err == nil {
		t.Fatal("expected error for zero duration")
	}
	entries, _ := os.ReadDir(opts.TempRoot)
	if len(entries) != 0 {
		t.Fatal("invalid options created a data dir")
	}
}

func TestFailedCountsBusyAndOtherErrors(t *testing.T) {
	var c counters
	c.classify(errors.New("database is locked"))
	c.classify(errors.New("boom"))
	c.classify(store.ErrNotFound)
	if got := c.failed(); got != 2 {
		t.Fatalf("failed = %d, want 2 (busy + other, not skipped)", got)
	}
}
