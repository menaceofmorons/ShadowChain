package sqlite

import (
	"testing"
	"time"
)

func TestPercentileNearestRank(t *testing.T) {
	ten := make([]time.Duration, 10)
	for i := range ten {
		ten[i] = time.Duration(i+1) * time.Millisecond
	}
	cases := []struct {
		name   string
		sorted []time.Duration
		p      float64
		want   time.Duration
	}{
		{"single p99", ten[:1], 0.99, 1 * time.Millisecond},
		{"ten p50", ten, 0.50, 5 * time.Millisecond},
		{"ten p95", ten, 0.95, 10 * time.Millisecond},
		{"ten p99", ten, 0.99, 10 * time.Millisecond},
		{"two p50", ten[:2], 0.50, 1 * time.Millisecond},
		{"two p95", ten[:2], 0.95, 2 * time.Millisecond},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := percentile(c.sorted, c.p); got != c.want {
				t.Fatalf("percentile = %v, want %v", got, c.want)
			}
		})
	}
}

func TestLatencyWindowKeepsMaxAfterTruncation(t *testing.T) {
	var w latencyWindow
	w.record(time.Hour)
	for i := 0; i < maxLatencySamples+10; i++ {
		w.record(time.Millisecond)
	}
	s := w.summary()
	if s.Max != time.Hour {
		t.Fatalf("Max = %v, want 1h", s.Max)
	}
	if !s.Truncated {
		t.Fatal("Truncated = false, want true")
	}
	if s.Count != int64(maxLatencySamples+11) {
		t.Fatalf("Count = %d", s.Count)
	}
}

func TestLatencyWindowNotTruncatedBelowCap(t *testing.T) {
	var w latencyWindow
	w.record(time.Millisecond)
	if w.summary().Truncated {
		t.Fatal("Truncated = true, want false")
	}
}
