package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const MaxSnapshotDuration = 30 * time.Second

const signatureSnapshotQuery = `SELECT id, tenant_id, system_id, sig_code, scan_kind, site_group, site_name,
	name_source, wh_type_code, expires_at, version
	FROM signature WHERE tenant_id = ? ORDER BY id`

const connectionSnapshotQuery = `SELECT id, tenant_id, kind, sig_a_id, system_a_id, sig_b_id, system_b_id,
	mass_status, version
	FROM connection WHERE tenant_id = ? ORDER BY id`

type Reader struct {
	db    *DB
	stats store.StatsRecorder
}

var _ store.SnapshotReader = (*Reader)(nil)

func NewReader(db *DB, stats store.StatsRecorder) *Reader {
	return &Reader{db: db, stats: stats}
}

func (r *Reader) ReadSnapshot(ctx context.Context, tenant store.TenantID) (store.TenantSnapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, MaxSnapshotDuration)
	defer cancel()

	start := time.Now()
	tx, err := r.db.Reader().BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return store.TenantSnapshot{}, fmt.Errorf("sqlite: begin snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	snap := store.TenantSnapshot{TenantID: tenant}
	if snap.Signatures, err = readSignatures(ctx, tx, tenant); err != nil {
		return store.TenantSnapshot{}, err
	}
	if snap.Connections, err = readConnections(ctx, tx, tenant); err != nil {
		return store.TenantSnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return store.TenantSnapshot{}, fmt.Errorf("sqlite: end snapshot: %w", err)
	}
	if r.stats != nil {
		r.stats.RecordSnapshotLatency(time.Since(start))
	}
	return snap, nil
}

func readSignatures(ctx context.Context, tx *sql.Tx, tenant store.TenantID) ([]store.Signature, error) {
	rows, err := tx.QueryContext(ctx, signatureSnapshotQuery, int64(tenant))
	if err != nil {
		return nil, fmt.Errorf("sqlite: read signatures: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []store.Signature
	for rows.Next() {
		var s store.Signature
		if err := rows.Scan(&s.ID, &s.TenantID, &s.SystemID, &s.SigCode, &s.ScanKind, &s.SiteGroup,
			&s.SiteName, &s.NameSource, &s.WHTypeCode, &s.ExpiresAt, &s.Version); err != nil {
			return nil, fmt.Errorf("sqlite: scan signature: %w", err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: read signatures: %w", err)
	}
	return out, nil
}

func readConnections(ctx context.Context, tx *sql.Tx, tenant store.TenantID) ([]store.Connection, error) {
	rows, err := tx.QueryContext(ctx, connectionSnapshotQuery, int64(tenant))
	if err != nil {
		return nil, fmt.Errorf("sqlite: read connections: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []store.Connection
	for rows.Next() {
		var c store.Connection
		if err := rows.Scan(&c.ID, &c.TenantID, &c.Kind, &c.SigAID, &c.SystemAID, &c.SigBID,
			&c.SystemBID, &c.MassStatus, &c.Version); err != nil {
			return nil, fmt.Errorf("sqlite: scan connection: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: read connections: %w", err)
	}
	return out, nil
}
