package sqlite

import (
	"math"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const maxLatencySamples = 100000

type latencyWindow struct {
	mu      sync.Mutex
	samples []time.Duration
	next    int
	count   int64
	max     time.Duration
}

func (w *latencyWindow) record(d time.Duration) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.count++
	w.max = max(w.max, d)
	if len(w.samples) < maxLatencySamples {
		w.samples = append(w.samples, d)
		return
	}
	w.samples[w.next] = d
	w.next = (w.next + 1) % maxLatencySamples
}

func (w *latencyWindow) summary() store.LatencySummary {
	w.mu.Lock()
	sorted := slices.Clone(w.samples)
	count := w.count
	maxSeen := w.max
	w.mu.Unlock()
	if len(sorted) == 0 {
		return store.LatencySummary{}
	}
	slices.Sort(sorted)
	return store.LatencySummary{
		Count:     count,
		P50:       percentile(sorted, 0.50),
		P95:       percentile(sorted, 0.95),
		P99:       percentile(sorted, 0.99),
		Max:       maxSeen,
		Truncated: count > int64(len(sorted)),
	}
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	rank := int(math.Ceil(p * float64(len(sorted))))
	return sorted[min(max(rank, 1), len(sorted))-1]
}

type Stats struct {
	queueWait       latencyWindow
	writeLatency    latencyWindow
	snapshotLatency latencyWindow
	walSize         atomic.Int64
}

var _ store.StoreStats = (*Stats)(nil)

func NewStats() *Stats { return &Stats{} }

func (s *Stats) RecordQueueWait(d time.Duration)       { s.queueWait.record(d) }
func (s *Stats) RecordWriteLatency(d time.Duration)    { s.writeLatency.record(d) }
func (s *Stats) RecordSnapshotLatency(d time.Duration) { s.snapshotLatency.record(d) }
func (s *Stats) RecordWALSize(bytes int64)             { s.walSize.Store(bytes) }
func (s *Stats) QueueWait() store.LatencySummary       { return s.queueWait.summary() }
func (s *Stats) WriteLatency() store.LatencySummary    { return s.writeLatency.summary() }
func (s *Stats) SnapshotLatency() store.LatencySummary { return s.snapshotLatency.summary() }
func (s *Stats) WALSize() int64                        { return s.walSize.Load() }
