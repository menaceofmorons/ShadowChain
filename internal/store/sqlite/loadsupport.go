package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

// PrepareLoadTenants applies the test schema and inserts tenants 1..count.
func PrepareLoadTenants(ctx context.Context, db *DB, count int) error {
	if err := ApplyTestSchema(ctx, db.Writer()); err != nil {
		return err
	}
	for t := 1; t <= count; t++ {
		if _, err := db.Writer().ExecContext(ctx, `INSERT INTO tenant (id) VALUES (?)`, t); err != nil {
			return fmt.Errorf("sqlite: seed tenant: %w", err)
		}
	}
	return nil
}

// NthConnectionID returns the id of the tenant's nth connection by id, or store.ErrNotFound.
func NthConnectionID(ctx context.Context, db *DB, tenant store.TenantID, n int) (int64, error) {
	var id int64
	err := db.Reader().QueryRowContext(ctx,
		`SELECT id FROM connection WHERE tenant_id = ? ORDER BY id LIMIT 1 OFFSET ?`, int64(tenant), n).Scan(&id)
	return id, notFound(err, "connection")
}

// NthSignatureVersion returns the id and version of the tenant's nth signature by id, or store.ErrNotFound.
func NthSignatureVersion(ctx context.Context, db *DB, tenant store.TenantID, n int) (id, version int64, err error) {
	err = db.Reader().QueryRowContext(ctx,
		`SELECT id, version FROM signature WHERE tenant_id = ? ORDER BY id LIMIT 1 OFFSET ?`, int64(tenant), n).Scan(&id, &version)
	return id, version, notFound(err, "signature")
}

// HoldWriterConnection takes the write connection until the returned release is called.
func HoldWriterConnection(ctx context.Context, db *DB) (release func(), err error) {
	conn, err := db.Writer().Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("sqlite: hold writer: %w", err)
	}
	return func() { _ = conn.Close() }, nil
}

func notFound(err error, what string) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, sql.ErrNoRows):
		return fmt.Errorf("sqlite: %s: %w", what, store.ErrNotFound)
	default:
		return fmt.Errorf("sqlite: %s lookup: %w", what, err)
	}
}
