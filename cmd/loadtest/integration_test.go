package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/menaceofmorons/ShadowChain/cmd/loadtest/scenario"
)

const testConfigPath = "contention.config.json"

var relaxedLatency = []string{
	"-set", "thresholds.writerQueueWaitP99Ms=60000",
	"-set", "thresholds.writerQueueWaitMaxMs=60000",
	"-set", "thresholds.writeLatencyP95Ms=60000",
	"-set", "thresholds.snapshotP95Ms=60000",
}

func runLoadtest(t *testing.T, args ...string) (int, scenario.Result, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := run(args, &stdout, &stderr)
	var res scenario.Result
	if stdout.Len() > 0 && containsFlag(args, "-json") {
		if err := json.Unmarshal(stdout.Bytes(), &res); err != nil {
			t.Fatalf("decode json: %v\n%s", err, stdout.String())
		}
	}
	return code, res, stdout.String() + stderr.String()
}

func containsFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

func TestIntegrationHundredTenantTargetRuns(t *testing.T) {
	args := append([]string{"-json", "-config", testConfigPath, "-set", "profile.durationMinutes=0.05"}, relaxedLatency...)
	code, res, out := runLoadtest(t, args...)
	if code != exitOK {
		t.Fatalf("exit = %d, want %d\n%s", code, exitOK, out)
	}
	p := res.Report.Config.Profile
	if p.Tenants != 100 || p.Characters != 500 {
		t.Fatalf("profile = %d tenants, %d characters; want the 100-tenant, 500-character target", p.Tenants, p.Characters)
	}
	if res.Counts.OtherErrors != 0 || res.Counts.Busy != 0 {
		t.Fatalf("errors: %+v (%s)", res.Counts, res.FirstError)
	}
	if res.Counts.Pastes == 0 || res.Counts.Jumps == 0 || res.Counts.Patches == 0 || res.Counts.Snapshots == 0 {
		t.Fatalf("workload incomplete: %+v", res.Counts)
	}
	wantMetrics := map[string]bool{
		"thresholds.writerQueueWaitP99Ms": false, "thresholds.writerQueueWaitMaxMs": false,
		"thresholds.writeLatencyP95Ms": false, "thresholds.snapshotP95Ms": false,
		"thresholds.walPeakMB": false, "thresholds.walPostCheckpointMB": false, "thresholds.busyErrors": false,
	}
	for _, m := range res.Report.Results {
		if _, ok := wantMetrics[m.Key]; !ok {
			t.Fatalf("unexpected metric %q", m.Key)
		}
		wantMetrics[m.Key] = true
		if !m.Pass {
			t.Errorf("metric %s failed under relaxed thresholds: %+v", m.Key, m)
		}
	}
	for key, seen := range wantMetrics {
		if !seen {
			t.Errorf("report is missing %s", key)
		}
	}
	if _, err := os.Stat(res.DataDir); !os.IsNotExist(err) {
		t.Errorf("data dir %q left behind: %v", res.DataDir, err)
	}
}

func TestIntegrationSnapshotRateOverrideDrivesReadVolume(t *testing.T) {
	base := append([]string{"-json", "-config", testConfigPath, "-set", "profile.durationMinutes=0.05"}, relaxedLatency...)

	issued := func(rate string) (int64, scenario.Result) {
		code, res, out := runLoadtest(t, append(base, "-set", "profile.snapshotsPerSecond="+rate)...)
		if code != exitOK {
			t.Fatalf("rate %s: exit = %d\n%s", rate, code, out)
		}
		if res.Counts.OtherErrors != 0 || res.Counts.Busy != 0 || res.Counts.MaintenanceFailures != 0 {
			t.Fatalf("rate %s: errors %+v (%s)", rate, res.Counts, res.FirstError)
		}
		return res.Counts.Snapshots, res
	}

	low, lowRes := issued("5")
	high, _ := issued("50")
	if got := lowRes.Report.Config.Profile.SnapshotsPerSecond; got != 5 {
		t.Errorf("report profile.snapshotsPerSecond = %v, want the override 5", got)
	}
	if lowRes.Windows < 1 {
		t.Fatalf("no windows planned: %+v", lowRes)
	}
	if low == 0 || high <= low {
		t.Fatalf("snapshots at 5/s = %d, at 50/s = %d; read volume must follow the configured rate", low, high)
	}
	wantLow := int64(5 * float64(lowRes.Report.Config.Profile.WindowMillis) / 1000 * float64(lowRes.Windows))
	if low != wantLow {
		t.Errorf("snapshots at 5/s = %d over %d windows, want exactly %d", low, lowRes.Windows, wantLow)
	}
}

func TestIntegrationSnapshotRateConfigDefaultIsUnchanged(t *testing.T) {
	code, res, out := runLoadtest(t, append([]string{"-json", "-short", "-config", testConfigPath}, relaxedLatency...)...)
	if code != exitOK {
		t.Fatalf("exit = %d\n%s", code, out)
	}
	if got := res.Report.Config.Profile.SnapshotsPerSecond; got != 100 {
		t.Errorf("config default profile.snapshotsPerSecond = %v, want 100", got)
	}
}

func TestIntegrationThresholdEditInConfigFileChangesVerdict(t *testing.T) {
	raw, err := os.ReadFile(testConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	thresholds, ok := doc["thresholds"].(map[string]any)
	if !ok {
		t.Fatal("config has no thresholds object")
	}
	for _, key := range []string{"writerQueueWaitP99Ms", "writerQueueWaitMaxMs", "writeLatencyP95Ms", "snapshotP95Ms"} {
		thresholds[key] = 60000
	}
	dir := t.TempDir()
	write := func(name string) string {
		out, err := json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, out, 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}

	passing := write("passing.json")
	code, res, out := runLoadtest(t, "-json", "-short", "-config", passing)
	if code != exitOK || !res.Report.Pass {
		t.Fatalf("relaxed config: exit = %d, pass = %v\n%s", code, res.Report.Pass, out)
	}

	thresholds["writeLatencyP95Ms"] = 0
	edited := write("edited.json")
	code, res, out = runLoadtest(t, "-json", "-short", "-config", edited)
	if code != exitFailed || res.Report.Pass {
		t.Fatalf("edited config: exit = %d, pass = %v, want a failed verdict\n%s", code, res.Report.Pass, out)
	}
	if res.Report.ConfigPath != edited {
		t.Errorf("report config path = %q, want %q", res.Report.ConfigPath, edited)
	}
	for _, m := range res.Report.Results {
		wantPass := m.Key != "thresholds.writeLatencyP95Ms"
		if m.Pass != wantPass {
			t.Errorf("metric %s pass = %v, want %v", m.Key, m.Pass, wantPass)
		}
	}
}

func TestIntegrationInvalidConfigNeverStartsScenario(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte(`{"version":1,"unknown":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := map[string][]string{
		"unknown key in file":   {"-config", bad},
		"negative override":     {"-config", testConfigPath, "-set", "thresholds.busyErrors=-1"},
		"unknown override key":  {"-config", testConfigPath, "-set", "thresholds.nope=1"},
		"missing config file":   {"-config", filepath.Join(t.TempDir(), "absent.json")},
		"unparseable flag":      {"-bogus"},
		"malformed override":    {"-config", testConfigPath, "-set", "profile.tenants"},
		"zero tenants override": {"-config", testConfigPath, "-set", "profile.tenants=0"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if code := run(append([]string{"-short"}, args...), &stdout, &stderr); code != exitUsage {
				t.Fatalf("exit = %d, want %d\nstderr: %s", code, exitUsage, stderr.String())
			}
			if strings.Contains(stdout.String(), "Verdict") || stdout.Len() != 0 {
				t.Fatalf("a report was produced for invalid config:\n%s", stdout.String())
			}
		})
	}
}

func TestIntegrationTextReportListsEveryRequiredMetric(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run(append([]string{"-short", "-config", testConfigPath}, relaxedLatency...), &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("exit = %d\n%s%s", code, stdout.String(), stderr.String())
	}
	for _, want := range []string{
		"Writer queue wait p99", "Writer queue wait max", "Write latency p95", "Snapshot p95 during paste bursts",
		"WAL size peak", "WAL size after TRUNCATE checkpoint", "Failed or SQLITE_BUSY transactions",
		"PASS", "Verdict: PASS", testConfigPath,
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("text report missing %q:\n%s", want, stdout.String())
		}
	}
}

func TestIntegrationReportsBusyCheckpointCount(t *testing.T) {
	args := append([]string{"-json", "-short", "-config", testConfigPath}, relaxedLatency...)
	var stdout, stderr bytes.Buffer
	if code := run(args, &stdout, &stderr); code != exitOK {
		t.Fatalf("exit = %d\n%s%s", code, stdout.String(), stderr.String())
	}
	var raw struct {
		Counts map[string]json.Number `json:"counts"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &raw); err != nil {
		t.Fatalf("decode json: %v", err)
	}
	for _, key := range []string{"busyCheckpoints", "maintenanceFailures", "otherErrors", "busy", "snapshots"} {
		if _, ok := raw.Counts[key]; !ok {
			t.Errorf("json counts has no %q: %v", key, raw.Counts)
		}
	}
	if got := raw.Counts["busyCheckpoints"].String(); got != "0" {
		t.Errorf("busyCheckpoints = %s with no reader holding the WAL, want 0", got)
	}

	stdout.Reset()
	if code := run(append([]string{"-short", "-config", testConfigPath}, relaxedLatency...), &stdout, &stderr); code != exitOK {
		t.Fatalf("text run exit = %d\n%s%s", code, stdout.String(), stderr.String())
	}
	for _, want := range []string{"busyCheckpoints=0", "maintenanceFailures=0"} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("text report missing %q:\n%s", want, stdout.String())
		}
	}
}

func TestIntegrationTextReportListsEveryProfileKey(t *testing.T) {
	var stdout, stderr bytes.Buffer
	args := append([]string{"-short", "-config", testConfigPath, "-set", "profile.snapshotsPerSecond=5"}, relaxedLatency...)
	if code := run(args, &stdout, &stderr); code != exitOK {
		t.Fatalf("exit = %d\n%s%s", code, stdout.String(), stderr.String())
	}
	for _, want := range []string{
		"tenants=", "characters=", "durationMinutes=", "burstShare=", "pasteSize=", "rarePasteSize=", "rarePasteShare=",
		"seed=", "windowMillis=", "burstEveryWindows=", "backgroundOpChance=", "jumpShare=", "snapshotsPerSecond=5",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("text report header missing %q:\n%s", want, stdout.String())
		}
	}
}
