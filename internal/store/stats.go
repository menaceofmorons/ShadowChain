package store

import "time"

type LatencySummary struct {
	Count int64
	P50   time.Duration
	P95   time.Duration
	P99   time.Duration
	Max   time.Duration
}

type StatsRecorder interface {
	RecordQueueWait(d time.Duration)
	RecordWriteLatency(d time.Duration)
	RecordSnapshotLatency(d time.Duration)
	RecordWALSize(bytes int64)
}

type StatsReader interface {
	QueueWait() LatencySummary
	WriteLatency() LatencySummary
	SnapshotLatency() LatencySummary
	WALSize() int64
}

type StoreStats interface {
	StatsRecorder
	StatsReader
}
