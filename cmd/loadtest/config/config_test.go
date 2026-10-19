package config

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const defaultPath = "../contention.config.json"

func readDefault(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(defaultPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "c.json")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestConfigDefaultsLoad(t *testing.T) {
	cfg, err := Load(defaultPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	th := cfg.Thresholds
	if th.WriterQueueWaitP99Ms != 50 || th.WriterQueueWaitMaxMs != 250 || th.WriteLatencyP95Ms != 100 ||
		th.SnapshotP95Ms != 500 || th.WALPeakMB != 256 || th.WALPostCheckpointMB != 64 || th.BusyErrors != 0 {
		t.Fatalf("thresholds: %+v", th)
	}
	p := cfg.Profile
	if p.Tenants != 100 || p.Characters != 500 || p.DurationMinutes != 10 || p.BurstShare != 0.2 ||
		p.PasteSizeMin != 10 || p.PasteSizeMax != 20 || p.RarePasteSizeMin != 30 || p.RarePasteSizeMax != 40 || p.RarePasteShare != 0.05 {
		t.Fatalf("profile: %+v", p)
	}
}

func TestConfigRejectsInvalid(t *testing.T) {
	def := readDefault(t)
	tests := []struct {
		name, from, to, wantErr string
	}{
		{"unknown top key", `"version": 1,`, `"version": 1, "extra": 1,`, "unknown"},
		{"unknown threshold key", `"busyErrors": 0`, `"busyErrors": 0, "bogus": 1`, "thresholds.bogus"},
		{"negative threshold", `"snapshotP95Ms": 500`, `"snapshotP95Ms": -1`, "snapshotP95Ms"},
		{"negative profile", `"tenants": 100`, `"tenants": -5`, "tenants"},
		{"missing threshold", `"walPeakMB": 256,`, ``, "missing"},
		{"missing section", `"profile": {`, `"profileX": {`, "missing"},
		{"wrong version", `"version": 1`, `"version": 2`, "version"},
		{"wrong type", `"seed": 1`, `"seed": "x"`, "seed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if !strings.Contains(def, tc.from) {
				t.Fatalf("fixture lacks %q", tc.from)
			}
			p := writeTemp(t, strings.Replace(def, tc.from, tc.to, 1))
			_, err := Load(p, nil)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
			}
		})
	}
}

func TestOverrideRejectsInvalid(t *testing.T) {
	for _, set := range []string{"nokey", "thresholds.nope=1", "other.x=1", "thresholds.snapshotP95Ms=abc", "thresholds.snapshotP95Ms=-3", "profile.burstShare=2", "profile.durationMinutes=NaN", "profile.burstShare=NaN", "thresholds.snapshotP95Ms=NaN", "thresholds.snapshotP95Ms=Inf", "thresholds.snapshotP95Ms=-Inf", "profile.pasteSizeMax=501", "profile.rarePasteSizeMax=501"} {
		if _, err := Load(defaultPath, []string{set}); err == nil {
			t.Errorf("%q accepted", set)
		}
	}
}

func TestOverridePrecedence(t *testing.T) {
	p := writeTemp(t, strings.Replace(readDefault(t), `"snapshotP95Ms": 500`, `"snapshotP95Ms": 300`, 1))
	cfg, err := Load(p, nil)
	if err != nil || cfg.Thresholds.SnapshotP95Ms != 300 {
		t.Fatalf("file value: %v %v", cfg.Thresholds.SnapshotP95Ms, err)
	}

	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	f := RegisterFlags(fs, defaultPath)
	if err := fs.Parse([]string{"-config", p, "-set", "thresholds.snapshotP95Ms=120", "-set", "profile.tenants=7", "-set", "profile.seed=9"}); err != nil {
		t.Fatal(err)
	}
	cfg, err = f.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Thresholds.SnapshotP95Ms != 120 || cfg.Profile.Tenants != 7 || cfg.Profile.Seed != 9 {
		t.Fatalf("flag did not override file: %+v", cfg)
	}
}
