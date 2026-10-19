package sqlite_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/menaceofmorons/ShadowChain/internal/store/sqlite"
)

func openTemp(t *testing.T, opts sqlite.Options) *sqlite.DB {
	t.Helper()
	db, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "test.db"), opts)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func pragmaInt(t *testing.T, conn *sql.Conn, name string) int64 {
	t.Helper()
	var v int64
	if err := conn.QueryRowContext(context.Background(), "PRAGMA "+name).Scan(&v); err != nil {
		t.Fatalf("pragma %s: %v", name, err)
	}
	return v
}

func checkPragmas(t *testing.T, label string, conn *sql.Conn, wantSync int64) {
	t.Helper()
	var mode string
	if err := conn.QueryRowContext(context.Background(), "PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatalf("%s journal_mode: %v", label, err)
	}
	if mode != "wal" {
		t.Errorf("%s journal_mode = %q, want wal", label, mode)
	}
	want := map[string]int64{
		"synchronous":        wantSync,
		"foreign_keys":       1,
		"busy_timeout":       sqlite.BusyTimeoutMillis,
		"wal_autocheckpoint": sqlite.WALAutocheckpoint,
	}
	for name, w := range want {
		if got := pragmaInt(t, conn, name); got != w {
			t.Errorf("%s %s = %d, want %d", label, name, got, w)
		}
	}
}

func TestOpenPragmas(t *testing.T) {
	cases := []struct {
		name     string
		sync     string
		wantSync int64
		readers  int
	}{
		{"default is normal", "", 1, 0},
		{"normal", "normal", 1, 4},
		{"full", "FULL", 2, 8},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := openTemp(t, sqlite.Options{Sync: tc.sync, ReadPoolSize: tc.readers})
			ctx := context.Background()

			wconn, err := db.Writer().Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = wconn.Close() }()
			checkPragmas(t, "writer", wconn, tc.wantSync)

			size := tc.readers
			if size == 0 {
				size = sqlite.DefaultReadPool
			}
			conns := make([]*sql.Conn, 0, size)
			for i := range size {
				c, err := db.Reader().Conn(ctx)
				if err != nil {
					t.Fatal(err)
				}
				conns = append(conns, c)
				checkPragmas(t, "reader", c, tc.wantSync)
				if got := pragmaInt(t, c, "query_only"); got != 1 {
					t.Errorf("reader %d query_only = %d, want 1", i, got)
				}
			}
			for _, c := range conns {
				_ = c.Close()
			}
		})
	}
}

func TestOpenRejectsBadOptions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.db")
	for _, opts := range []sqlite.Options{
		{Sync: "off"},
		{ReadPoolSize: 3},
		{ReadPoolSize: 9},
	} {
		if db, err := sqlite.Open(context.Background(), path, opts); err == nil {
			_ = db.Close()
			t.Errorf("Open(%+v) succeeded, want error", opts)
		}
	}
}

func TestSingleWriteConnection(t *testing.T) {
	db := openTemp(t, sqlite.Options{})
	ctx := context.Background()

	tx, err := db.Writer().BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}

	waitCtx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	second, err := db.Writer().Conn(waitCtx)
	if err == nil {
		_ = second.Close()
		t.Fatal("second writer connection opened while first is held")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second writer error = %v, want deadline exceeded", err)
	}
	if open := db.Writer().Stats().OpenConnections; open != 1 {
		t.Errorf("writer open connections = %d, want 1", open)
	}

	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	conn, err := db.Writer().Conn(ctx)
	if err != nil {
		t.Fatalf("writer unavailable after release: %v", err)
	}
	_ = conn.Close()
}

func TestSchemaConstraints(t *testing.T) {
	db := openTemp(t, sqlite.Options{})
	ctx := context.Background()
	if err := sqlite.ApplyTestSchema(ctx, db.Writer()); err != nil {
		t.Fatal(err)
	}
	w := db.Writer()

	t.Run("tenant_id-leading index on every tenant table", func(t *testing.T) {
		for _, table := range []string{"signature", "connection", "jump_log", "change_log"} {
			if !hasTenantLeadingIndex(t, w, table) {
				t.Errorf("%s has no tenant_id-leading index", table)
			}
		}
	})

	t.Run("change_log indexes", func(t *testing.T) {
		want := map[string]bool{"change_log_tenant_at": false, "change_log_tenant_actor_at": false, "change_log_batch": false}
		rows, err := w.QueryContext(ctx, "SELECT name FROM pragma_index_list('change_log')")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				t.Fatal(err)
			}
			if _, ok := want[name]; ok {
				want[name] = true
			}
		}
		for name, found := range want {
			if !found {
				t.Errorf("missing index %s", name)
			}
		}
	})

	t.Run("tables are STRICT", func(t *testing.T) {
		for _, table := range []string{"tenant", "signature", "connection", "jump_log", "change_log"} {
			var strict int
			if err := w.QueryRowContext(ctx, "SELECT strict FROM pragma_table_list WHERE name = ?", table).Scan(&strict); err != nil {
				t.Fatal(err)
			}
			if strict != 1 {
				t.Errorf("%s is not STRICT", table)
			}
		}
	})

	t.Run("STRICT rejects wrong type", func(t *testing.T) {
		if _, err := w.ExecContext(ctx, "INSERT INTO tenant (id) VALUES ('not a number')"); err == nil {
			t.Error("text accepted into INTEGER column")
		}
	})

	t.Run("foreign keys rejected", func(t *testing.T) {
		_, err := w.ExecContext(ctx, `INSERT INTO signature
			(tenant_id, system_id, scan_kind, site_group, site_name, name_source, created_at, created_by, modified_at, modified_by)
			VALUES (999, 1, 'signature', 'unknown', 'x', 'paste', 0, 0, 0, 0)`)
		if err == nil {
			t.Error("signature with unknown tenant accepted")
		}
		_, err = w.ExecContext(ctx, `INSERT INTO jump_log
			(tenant_id, connection_id, jumped_at, character_id, character_name, ship_type_id, base_mass, higgs, hot, effective_mass, from_system_id, source)
			VALUES (1, 1, 0, 1, 'c', 1, 1, 0, 0, 1, 1, 'manual')`)
		if err == nil {
			t.Error("jump_log with unknown connection accepted")
		}
	})

	t.Run("cascade delete", func(t *testing.T) {
		mustExec(t, w, "INSERT INTO tenant (id) VALUES (1)")
		mustExec(t, w, `INSERT INTO signature
			(id, tenant_id, system_id, sig_code, scan_kind, site_group, site_name, name_source, created_at, created_by, modified_at, modified_by)
			VALUES (1, 1, 10, 'ABC-123', 'signature', 'wormhole', 'x', 'paste', 0, 0, 0, 0)`)
		mustExec(t, w, `INSERT INTO connection
			(id, tenant_id, kind, sig_a_id, system_a_id, leads_to_source, lifetime_source, size, size_source, life_stage, life_stage_at, life_source, mass_status, created_at, created_by, modified_at, modified_by)
			VALUES (1, 1, 'wormhole', 1, 10, 'auto', 'auto', 'unknown', 'auto', 1, 0, 'default', 'fresh', 0, 0, 0, 0)`)
		mustExec(t, w, `INSERT INTO jump_log
			(tenant_id, connection_id, jumped_at, character_id, character_name, ship_type_id, base_mass, higgs, hot, effective_mass, from_system_id, source)
			VALUES (1, 1, 0, 1, 'c', 1, 1, 0, 0, 1, 10, 'manual')`)
		mustExec(t, w, "DELETE FROM connection WHERE id = 1")
		var n int
		if err := w.QueryRowContext(ctx, "SELECT COUNT(*) FROM jump_log").Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Errorf("jump_log rows after connection delete = %d, want 0", n)
		}
	})

	t.Run("gate must not carry signatures", func(t *testing.T) {
		_, err := w.ExecContext(ctx, `INSERT INTO connection
			(tenant_id, kind, sig_a_id, system_a_id, system_b_id, leads_to_source, lifetime_source, size, size_source, life_stage, life_stage_at, life_source, mass_status, created_at, created_by, modified_at, modified_by)
			VALUES (1, 'gate', 1, 10, 11, 'auto', 'auto', 'unknown', 'auto', 1, 0, 'default', 'fresh', 0, 0, 0, 0)`)
		if err == nil {
			t.Error("gate with sig_a_id accepted")
		}
	})
}

func mustExec(t *testing.T, db *sql.DB, query string) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(), query); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

func hasTenantLeadingIndex(t *testing.T, db *sql.DB, table string) bool {
	t.Helper()
	ctx := context.Background()
	rows, err := db.QueryContext(ctx, "SELECT name FROM pragma_index_list(?)", table)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		var first string
		if err := db.QueryRowContext(ctx, "SELECT name FROM pragma_index_info(?) WHERE seqno = 0", name).Scan(&first); err != nil {
			t.Fatal(err)
		}
		if first == "tenant_id" {
			return true
		}
	}
	return false
}
