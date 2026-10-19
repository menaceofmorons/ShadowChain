package sqlite_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/menaceofmorons/ShadowChain/internal/store"
	"github.com/menaceofmorons/ShadowChain/internal/store/sqlite"
)

func TestLoadSupportLookups(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "load.db"), sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if err := sqlite.PrepareLoadTenants(ctx, db, 2); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if _, err := sqlite.NthConnectionID(ctx, db, 1, 0); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("empty connection lookup err = %v, want ErrNotFound", err)
	}
	if _, _, err := sqlite.NthSignatureVersion(ctx, db, 2, 0); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("empty signature lookup err = %v, want ErrNotFound", err)
	}

	st := sqlite.NewStore(db, sqlite.NewStats())
	defer st.Close()
	lines := []store.PasteLine{
		{SigCode: "AAA-001", ScanKind: "signature", SiteGroup: "gas", SiteName: "Site 1"},
		{SigCode: "AAA-002", ScanKind: "signature", SiteGroup: "gas", SiteName: "Site 2"},
	}
	cmd := store.PasteCommand{SystemID: 30000001, Actor: store.Actor{CharacterID: 1, Name: "P"}, Lines: lines}
	if _, err := st.ApplyPaste(ctx, 1, cmd); err != nil {
		t.Fatalf("paste: %v", err)
	}
	id0, v0, err := sqlite.NthSignatureVersion(ctx, db, 1, 0)
	if err != nil || v0 < 1 {
		t.Fatalf("first signature: id %d version %d err %v", id0, v0, err)
	}
	id1, _, err := sqlite.NthSignatureVersion(ctx, db, 1, 1)
	if err != nil || id1 <= id0 {
		t.Fatalf("second signature id %d not after %d (err %v)", id1, id0, err)
	}
	if _, _, err := sqlite.NthSignatureVersion(ctx, db, 2, 0); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("tenant 2 saw tenant 1 signature: %v", err)
	}
}

func TestHoldWriterConnectionBlocksWriter(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "hold.db"), sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	release, err := sqlite.HoldWriterConnection(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	short, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if _, err := db.Writer().Conn(short); err == nil {
		t.Fatal("second writer connection acquired while held")
	}
	release()
	conn, err := db.Writer().Conn(ctx)
	if err != nil {
		t.Fatalf("writer not free after release: %v", err)
	}
	_ = conn.Close()
}
