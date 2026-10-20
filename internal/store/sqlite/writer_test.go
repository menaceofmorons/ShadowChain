package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const testTenant store.TenantID = 1

var testActor = store.Actor{CharacterID: 9001, Name: "Scanner"}

func newTestStore(t *testing.T) (*Store, *Stats, *DB) {
	t.Helper()
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "test.db"), Options{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := ApplyTestSchema(ctx, db.Writer()); err != nil {
		t.Fatalf("schema: %v", err)
	}
	for _, id := range []int{1, 2} {
		if _, err := db.Writer().Exec(`INSERT INTO tenant (id) VALUES (?)`, id); err != nil {
			t.Fatalf("tenant: %v", err)
		}
	}
	stats := NewStats()
	s := NewStore(db, stats)
	t.Cleanup(func() {
		s.Close()
		_ = db.Close()
	})
	return s, stats, db
}

func countRows(t *testing.T, db *DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.Reader().QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

func sigLines(n int) []store.PasteLine {
	lines := make([]store.PasteLine, n)
	for i := range lines {
		lines[i] = store.PasteLine{
			SigCode:   fmt.Sprintf("ABC-%03d", i),
			ScanKind:  "signature",
			SiteGroup: "gas",
			SiteName:  "Gas Site",
		}
	}
	return lines
}

func TestPasteAppliesOneBatch(t *testing.T) {
	s, _, db := newTestStore(t)
	lines := []store.PasteLine{
		{SigCode: "AAA-111", ScanKind: "signature", SiteGroup: "wormhole", WHTypeCode: "K162"},
		{SigCode: "BBB-222", ScanKind: "signature", SiteGroup: "gas", SiteName: "Nebula"},
		{SigCode: "CCC-333"},
	}
	res, err := s.ApplyPaste(context.Background(), testTenant, store.PasteCommand{SystemID: 30000142, Actor: testActor, Lines: lines})
	if err != nil {
		t.Fatalf("paste: %v", err)
	}
	if res.Created != 3 || res.Updated != 0 || res.BatchID == "" {
		t.Fatalf("result = %+v", res)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM change_log WHERE batch_id = ?`, res.BatchID); got != 4 {
		t.Fatalf("batch change rows = %d, want 4 (3 signatures + 1 connection)", got)
	}
	if got := countRows(t, db, `SELECT COUNT(DISTINCT batch_id) FROM change_log`); got != 1 {
		t.Fatalf("distinct batches = %d, want 1", got)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM connection WHERE system_b_id IS NULL AND life_stage = 2 AND mass_status = 'fresh'`); got != 1 {
		t.Fatalf("wormhole connections = %d, want 1", got)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM change_log WHERE batch_id = ? AND op = 'create' AND before_json IS NULL AND after_json IS NOT NULL`, res.BatchID); got != 4 {
		t.Fatalf("create rows with after only = %d, want 4", got)
	}
}

func TestPasteMatchesExistingSignatures(t *testing.T) {
	s, _, db := newTestStore(t)
	ctx := context.Background()
	first := store.PasteCommand{SystemID: 1, Actor: testActor, Lines: []store.PasteLine{
		{SigCode: "AAA-111"},
		{SigCode: "BBB-222", SiteGroup: "gas", SiteName: "Nebula"},
	}}
	if _, err := s.ApplyPaste(ctx, testTenant, first); err != nil {
		t.Fatalf("first paste: %v", err)
	}
	repeat, err := s.ApplyPaste(ctx, testTenant, first)
	if err != nil {
		t.Fatalf("repeat paste: %v", err)
	}
	if repeat.Created != 0 || repeat.Updated != 0 {
		t.Fatalf("repeat result = %+v, want no creates or updates", repeat)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM change_log`); got != 2 {
		t.Fatalf("change_log rows after repeat = %d, want 2", got)
	}

	upgrade := store.PasteCommand{SystemID: 1, Actor: testActor, Lines: []store.PasteLine{
		{SigCode: "AAA-111", ScanKind: "signature", SiteGroup: "wormhole", SiteName: "Wormhole"},
	}}
	res, err := s.ApplyPaste(ctx, testTenant, upgrade)
	if err != nil {
		t.Fatalf("upgrade paste: %v", err)
	}
	if res.Created != 0 || res.Updated != 1 {
		t.Fatalf("upgrade result = %+v", res)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM signature WHERE tenant_id = 1 AND system_id = 1`); got != 2 {
		t.Fatalf("signatures = %d, want 2", got)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM connection`); got != 1 {
		t.Fatalf("connections after wormhole upgrade = %d, want 1", got)
	}
	if got := countRows(t, db, `SELECT version FROM signature WHERE sig_code = 'AAA-111'`); got != 2 {
		t.Fatalf("version = %d, want 2", got)
	}

	if _, err := s.ApplyPaste(ctx, testTenant, upgrade); err != nil {
		t.Fatalf("idempotent paste: %v", err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM connection`); got != 1 {
		t.Fatalf("connections after repeat = %d, want 1", got)
	}

	otherSystem := store.PasteCommand{SystemID: 2, Actor: testActor, Lines: []store.PasteLine{{SigCode: "AAA-111"}}}
	res, err = s.ApplyPaste(ctx, testTenant, otherSystem)
	if err != nil || res.Created != 1 {
		t.Fatalf("other system: %+v %v", res, err)
	}
	res, err = s.ApplyPaste(ctx, 2, store.PasteCommand{SystemID: 1, Actor: testActor, Lines: []store.PasteLine{{SigCode: "AAA-111"}}})
	if err != nil || res.Created != 1 {
		t.Fatalf("other tenant: %+v %v", res, err)
	}
}

func TestPasteDoesNotOverwriteUserName(t *testing.T) {
	s, _, db := newTestStore(t)
	ctx := context.Background()
	if _, err := s.ApplyPaste(ctx, testTenant, store.PasteCommand{SystemID: 1, Actor: testActor, Lines: []store.PasteLine{{SigCode: "AAA-111", SiteName: "Old"}}}); err != nil {
		t.Fatal(err)
	}
	name := "Mine"
	if _, err := s.PatchSignature(ctx, testTenant, 1, testActor, store.SignaturePatch{ExpectedVersion: 1, SiteName: &name}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPaste(ctx, testTenant, store.PasteCommand{SystemID: 1, Actor: testActor, Lines: []store.PasteLine{{SigCode: "AAA-111", SiteName: "Pasted"}}}); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := db.Reader().QueryRow(`SELECT site_name FROM signature WHERE id = 1`).Scan(&got); err != nil || got != "Mine" {
		t.Fatalf("site_name = %q, %v", got, err)
	}
}

func TestPasteCap(t *testing.T) {
	s, _, db := newTestStore(t)
	ctx := context.Background()
	res, err := s.ApplyPaste(ctx, testTenant, store.PasteCommand{SystemID: 1, Actor: testActor, Lines: sigLines(500)})
	if err != nil || res.Created != 500 {
		t.Fatalf("500 lines: %+v %v", res, err)
	}
	_, err = s.ApplyPaste(ctx, testTenant, store.PasteCommand{SystemID: 2, Actor: testActor, Lines: sigLines(501)})
	if !errors.Is(err, store.ErrPasteTooLarge) {
		t.Fatalf("501 lines err = %v, want ErrPasteTooLarge", err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM signature WHERE system_id = 2`); got != 0 {
		t.Fatalf("rejected paste wrote %d signatures", got)
	}
}

func TestPasteInvalidLineRollsBackWholePaste(t *testing.T) {
	s, _, db := newTestStore(t)
	_, err := s.ApplyPaste(context.Background(), testTenant, store.PasteCommand{SystemID: 1, Actor: testActor, Lines: []store.PasteLine{
		{SigCode: "AAA-111"}, {SigCode: "bad"},
	}})
	if !errors.Is(err, store.ErrInvalidSigCode) {
		t.Fatalf("err = %v", err)
	}
	if got := countRows(t, db, `SELECT (SELECT COUNT(*) FROM signature) + (SELECT COUNT(*) FROM change_log)`); got != 0 {
		t.Fatalf("rows left after rollback = %d", got)
	}
}

func TestPatchSignature(t *testing.T) {
	s, _, db := newTestStore(t)
	ctx := context.Background()
	if _, err := s.ApplyPaste(ctx, testTenant, store.PasteCommand{SystemID: 1, Actor: testActor, Lines: []store.PasteLine{{SigCode: "AAA-111", SiteGroup: "gas", SiteName: "Nebula"}}}); err != nil {
		t.Fatal(err)
	}
	group := "relic"
	got, err := s.PatchSignature(ctx, testTenant, 1, testActor, store.SignaturePatch{ExpectedVersion: 1, SiteGroup: &group})
	if err != nil || got.Version != 2 || got.SiteGroup != "relic" {
		t.Fatalf("patch: %+v %v", got, err)
	}
	var before, after string
	if err := db.Reader().QueryRow(`SELECT before_json, after_json FROM change_log WHERE op = 'update'`).Scan(&before, &after); err != nil {
		t.Fatal(err)
	}
	if before != `{"site_group":"gas","version":1}` || after != `{"site_group":"relic","version":2}` {
		t.Fatalf("change json before=%s after=%s", before, after)
	}
	if _, err := s.PatchSignature(ctx, testTenant, 1, testActor, store.SignaturePatch{ExpectedVersion: 1, SiteGroup: &group}); !errors.Is(err, store.ErrVersionConflict) {
		t.Fatalf("stale version err = %v", err)
	}
	if _, err := s.PatchSignature(ctx, 2, 1, testActor, store.SignaturePatch{ExpectedVersion: 2, SiteGroup: &group}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant err = %v", err)
	}
}

func TestLogJump(t *testing.T) {
	s, _, db := newTestStore(t)
	ctx := context.Background()
	if _, err := s.ApplyPaste(ctx, testTenant, store.PasteCommand{SystemID: 1, Actor: testActor, Lines: []store.PasteLine{{SigCode: "AAA-111", SiteGroup: "wormhole"}}}); err != nil {
		t.Fatal(err)
	}
	entry := store.JumpEntry{ConnectionID: 1, CharacterID: 9001, CharacterName: "Scanner", ShipTypeID: 1, BaseMass: 100, EffectiveMass: 100, FromSystemID: 1, Source: "manual"}
	if err := s.LogJump(ctx, testTenant, testActor, entry); err != nil {
		t.Fatalf("log jump: %v", err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM jump_log`); got != 1 {
		t.Fatalf("jump rows = %d", got)
	}
	if got := countRows(t, db, `SELECT version FROM connection WHERE id = 1`); got != 2 {
		t.Fatalf("connection version = %d", got)
	}
	if err := s.LogJump(ctx, 2, testActor, entry); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant err = %v", err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM jump_log`); got != 1 {
		t.Fatalf("cross-tenant jump rows = %d", got)
	}
}

func TestWriterSerialises(t *testing.T) {
	s, _, db := newTestStore(t)
	ctx := context.Background()
	const workers = 64
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cmd := store.PasteCommand{SystemID: store.SystemID(i), Actor: testActor, Lines: sigLines(10)}
			_, err := s.ApplyPaste(ctx, testTenant, cmd)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent paste: %v", err)
		}
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM signature`); got != workers*10 {
		t.Fatalf("signatures = %d, want %d", got, workers*10)
	}
}

func TestStatsRecordQueueWaitAndLatency(t *testing.T) {
	s, stats, _ := newTestStore(t)
	const commands = 5
	for i := 0; i < commands; i++ {
		cmd := store.PasteCommand{SystemID: store.SystemID(i), Actor: testActor, Lines: sigLines(3)}
		if _, err := s.ApplyPaste(context.Background(), testTenant, cmd); err != nil {
			t.Fatal(err)
		}
	}
	wait, write := stats.QueueWait(), stats.WriteLatency()
	if wait.Count != commands || write.Count != commands {
		t.Fatalf("counts wait=%d write=%d, want %d", wait.Count, write.Count, commands)
	}
	if write.Max < 0 || write.P50 < 0 || write.P99 < write.P50 || write.Max < write.P99 {
		t.Fatalf("write latency summary inconsistent: %+v", write)
	}
	if write.Max < wait.Max {
		t.Fatalf("write latency %v below queue wait %v", write.Max, wait.Max)
	}
}

func TestChangeLogAppendInSameTransaction(t *testing.T) {
	s, _, db := newTestStore(t)
	ctx := context.Background()
	failing := errors.New("forced failure")
	err := s.execute(ctx, func(tx *sql.Tx) error {
		if err := appendChange(tx, changeEntry{
			tenant: testTenant, batchID: "b1", at: 1, actor: testActor,
			entity: "signature", entityID: 1, op: "create", after: map[string]any{"k": 1},
		}); err != nil {
			return err
		}
		return failing
	})
	if !errors.Is(err, failing) {
		t.Fatalf("err = %v", err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM change_log`); got != 0 {
		t.Fatalf("change_log rows after rollback = %d", got)
	}
	err = s.execute(ctx, func(tx *sql.Tx) error {
		return appendChange(tx, changeEntry{
			tenant: testTenant, batchID: "b2", at: 1, actor: testActor,
			entity: "signature", entityID: 1, op: "create",
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM change_log`); got != 1 {
		t.Fatalf("change_log rows after commit = %d", got)
	}
}

func TestClosedStoreRejectsCommands(t *testing.T) {
	s, _, _ := newTestStore(t)
	s.Close()
	_, err := s.ApplyPaste(context.Background(), testTenant, store.PasteCommand{SystemID: 1, Actor: testActor, Lines: sigLines(1)})
	if !errors.Is(err, ErrClosed) {
		t.Fatalf("err = %v", err)
	}
}
