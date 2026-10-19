package scenario

import (
	"context"
	"reflect"
	"testing"
)

func TestSnapshotRateRespected(t *testing.T) {
	p := loadDefault(t).Profile
	p.SnapshotsPerSecond = 37.5
	const windows = 400
	total := 0
	for _, w := range BuildPlan(p, windows) {
		total += len(w.Snapshots)
		for _, s := range w.Snapshots {
			if s.Tenant < 1 || s.Tenant > p.Tenants || s.Offset < 0 || s.Offset >= 1 {
				t.Fatalf("snapshot read out of range: %+v", s)
			}
		}
	}
	want := p.SnapshotsPerSecond * float64(p.WindowMillis) / 1000 * windows
	if got := float64(total); got < want*0.95 || got > want*1.05 {
		t.Fatalf("planned %v snapshot reads, want %v within 5%%", got, want)
	}
}

func TestSnapshotRateDoesNotChangeWrites(t *testing.T) {
	p := loadDefault(t).Profile
	a := BuildPlan(p, 10)
	p.SnapshotsPerSecond *= 3
	b := BuildPlan(p, 10)
	for i := range a {
		if !reflect.DeepEqual(a[i].Pastes, b[i].Pastes) || !reflect.DeepEqual(a[i].Background, b[i].Background) {
			t.Fatalf("window %d writes changed with snapshot rate", i)
		}
	}
}

func TestSnapshotsPlannedInBurstWindows(t *testing.T) {
	p := loadDefault(t).Profile
	burstReads := 0
	for _, w := range BuildPlan(p, 40) {
		if w.Burst {
			burstReads += len(w.Snapshots)
		}
	}
	if burstReads == 0 {
		t.Fatal("no snapshot reads planned during burst windows")
	}
}

func TestSnapshotCountFollowsRate(t *testing.T) {
	opts := shortTestOptions(t)
	opts.Config.Profile.SnapshotsPerSecond = 40
	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	planned := 0
	for _, w := range BuildPlan(opts.Config.Profile, res.Windows) {
		planned += len(w.Snapshots)
	}
	if res.Counts.Snapshots != int64(planned) || res.Counts.SnapshotSamples == 0 {
		t.Fatalf("snapshots issued %d (samples %d), planned %d", res.Counts.Snapshots, res.Counts.SnapshotSamples, planned)
	}
}

func TestBurstWindowsPlaceReadsAtBurstStart(t *testing.T) {
	p := loadDefault(t).Profile
	p.SnapshotsPerSecond = 100
	atStart := func(burst bool) int {
		n := 0
		for _, w := range BuildPlan(p, 40) {
			if w.Burst != burst {
				continue
			}
			for _, s := range w.Snapshots {
				if s.Offset == 0 {
					n++
				}
			}
		}
		return n
	}
	if atStart(true) == 0 {
		t.Error("burst windows have no reads at the burst start")
	}
	if atStart(false) != 0 {
		t.Error("non-burst windows have reads at the burst start")
	}
}
