package sqlite

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const queueDepth = 256

var ErrClosed = errors.New("sqlite: store closed")

type command func(tx *sql.Tx) error

type job struct {
	ctx      context.Context
	enqueued time.Time
	run      command
	done     chan error
}

type Store struct {
	db    *DB
	stats store.StatsRecorder
	now   func() time.Time

	mu     sync.RWMutex
	closed bool
	queue  chan *job
	exited chan struct{}
}

var (
	_ store.SignatureRepository = (*Store)(nil)
	_ store.JumpRepository      = (*Store)(nil)
)

func NewStore(db *DB, stats store.StatsRecorder) *Store {
	s := &Store{
		db:     db,
		stats:  stats,
		now:    time.Now,
		queue:  make(chan *job, queueDepth),
		exited: make(chan struct{}),
	}
	go s.writerLoop()
	return s
}

func (s *Store) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.queue)
	s.mu.Unlock()
	<-s.exited
}

func (s *Store) execute(ctx context.Context, run command) error {
	j := &job{ctx: ctx, enqueued: time.Now(), run: run, done: make(chan error, 1)}
	s.mu.RLock()
	if s.closed {
		s.mu.RUnlock()
		return ErrClosed
	}
	select {
	case s.queue <- j:
	case <-ctx.Done():
		s.mu.RUnlock()
		return ctx.Err()
	}
	s.mu.RUnlock()
	return <-j.done
}

func (s *Store) writerLoop() {
	defer close(s.exited)
	for j := range s.queue {
		s.stats.RecordQueueWait(time.Since(j.enqueued))
		err := s.runJob(j)
		s.stats.RecordWriteLatency(time.Since(j.enqueued))
		j.done <- err
	}
}

func (s *Store) runJob(j *job) error {
	if err := j.ctx.Err(); err != nil {
		return err
	}
	tx, err := s.db.Writer().BeginTx(j.ctx, nil)
	if err != nil {
		return fmt.Errorf("sqlite: begin: %w", err)
	}
	if err := j.run(tx); err != nil {
		return errors.Join(err, tx.Rollback())
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("sqlite: commit: %w", err)
	}
	return nil
}

func newBatchID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("sqlite: batch id: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

type changeEntry struct {
	tenant   store.TenantID
	batchID  string
	at       int64
	actor    store.Actor
	entity   string
	entityID int64
	op       string
	before   map[string]any
	after    map[string]any
}

func appendChange(tx *sql.Tx, c changeEntry) error {
	before, err := marshalNullable(c.before)
	if err != nil {
		return err
	}
	after, err := marshalNullable(c.after)
	if err != nil {
		return err
	}
	_, err = tx.Exec(
		`INSERT INTO change_log (tenant_id, batch_id, at, actor_character_id, actor_name, entity, entity_id, op, before_json, after_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		int64(c.tenant), c.batchID, c.at, c.actor.CharacterID, c.actor.Name, c.entity, c.entityID, c.op, before, after,
	)
	if err != nil {
		return fmt.Errorf("sqlite: append change log: %w", err)
	}
	return nil
}

func marshalNullable(m map[string]any) (any, error) {
	if m == nil {
		return nil, nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("sqlite: marshal change: %w", err)
	}
	return string(b), nil
}
