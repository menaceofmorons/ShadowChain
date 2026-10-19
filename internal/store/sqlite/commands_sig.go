package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const signatureColumns = `id, tenant_id, system_id, sig_code, scan_kind, site_group, site_name, name_source, wh_type_code, expires_at, version`

func scanSignature(row *sql.Row) (store.Signature, error) {
	var sig store.Signature
	var tenant, system int64
	err := row.Scan(&sig.ID, &tenant, &system, &sig.SigCode, &sig.ScanKind, &sig.SiteGroup, &sig.SiteName,
		&sig.NameSource, &sig.WHTypeCode, &sig.ExpiresAt, &sig.Version)
	sig.TenantID = store.TenantID(tenant)
	sig.SystemID = store.SystemID(system)
	return sig, err
}

func loadSignatureByID(tx *sql.Tx, tenant store.TenantID, id int64) (store.Signature, error) {
	sig, err := scanSignature(tx.QueryRow(
		`SELECT `+signatureColumns+` FROM signature WHERE id = ? AND tenant_id = ?`, id, int64(tenant)))
	if errors.Is(err, sql.ErrNoRows) {
		return store.Signature{}, store.ErrNotFound
	}
	if err != nil {
		return store.Signature{}, fmt.Errorf("sqlite: load signature: %w", err)
	}
	return sig, nil
}

func (s *Store) PatchSignature(ctx context.Context, tenant store.TenantID, signatureID int64, actor store.Actor, patch store.SignaturePatch) (store.Signature, error) {
	var result store.Signature
	err := s.execute(ctx, func(tx *sql.Tx) error {
		current, err := loadSignatureByID(tx, tenant, signatureID)
		if err != nil {
			return err
		}
		if current.Version != patch.ExpectedVersion {
			return store.ErrVersionConflict
		}
		updated, before, after := applyPatch(current, patch)
		if len(after) == 0 {
			result = current
			return nil
		}
		now := s.now().Unix()
		updated.Version = current.Version + 1
		after["version"] = updated.Version
		before["version"] = current.Version
		_, err = tx.Exec(
			`UPDATE signature SET site_group = ?, site_name = ?, name_source = ?, wh_type_code = ?,
			 version = ?, modified_at = ?, modified_by = ? WHERE id = ? AND tenant_id = ?`,
			updated.SiteGroup, updated.SiteName, updated.NameSource, updated.WHTypeCode,
			updated.Version, now, actor.CharacterID, signatureID, int64(tenant))
		if err != nil {
			return fmt.Errorf("sqlite: patch signature: %w", err)
		}
		batch, err := newBatchID()
		if err != nil {
			return err
		}
		if err := appendChange(tx, changeEntry{
			tenant: tenant, batchID: batch, at: now, actor: actor,
			entity: "signature", entityID: signatureID, op: "update", before: before, after: after,
		}); err != nil {
			return err
		}
		result = updated
		return nil
	})
	if err != nil {
		return store.Signature{}, err
	}
	return result, nil
}

func applyPatch(current store.Signature, patch store.SignaturePatch) (store.Signature, map[string]any, map[string]any) {
	updated := current
	before := map[string]any{}
	after := map[string]any{}
	if patch.SiteGroup != nil && *patch.SiteGroup != current.SiteGroup {
		updated.SiteGroup = *patch.SiteGroup
		before["site_group"] = current.SiteGroup
		after["site_group"] = updated.SiteGroup
	}
	if patch.SiteName != nil && *patch.SiteName != current.SiteName {
		updated.SiteName = *patch.SiteName
		before["site_name"] = current.SiteName
		after["site_name"] = updated.SiteName
		if current.NameSource != "user" {
			updated.NameSource = "user"
			before["name_source"] = current.NameSource
			after["name_source"] = updated.NameSource
		}
	}
	if patch.WHTypeCode != nil && !sameString(patch.WHTypeCode, current.WHTypeCode) {
		updated.WHTypeCode = patch.WHTypeCode
		before["wh_type_code"] = current.WHTypeCode
		after["wh_type_code"] = updated.WHTypeCode
	}
	return updated, before, after
}

func sameString(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
