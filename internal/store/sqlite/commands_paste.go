package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

var sigCodePattern = regexp.MustCompile(`^[A-Z]{3}-[0-9]{3}$`)

func isUnknownGroup(group string) bool {
	return group == "" || group == "unknown"
}

func (s *Store) ApplyPaste(ctx context.Context, tenant store.TenantID, cmd store.PasteCommand) (store.PasteResult, error) {
	if len(cmd.Lines) > store.MaxPasteLines {
		return store.PasteResult{}, store.ErrPasteTooLarge
	}
	var result store.PasteResult
	err := s.execute(ctx, func(tx *sql.Tx) error {
		batch, err := newBatchID()
		if err != nil {
			return err
		}
		result = store.PasteResult{BatchID: batch}
		now := s.now().Unix()
		for _, line := range cmd.Lines {
			line.SigCode = strings.TrimSpace(line.SigCode)
			if !sigCodePattern.MatchString(line.SigCode) {
				return fmt.Errorf("%w: %q", store.ErrInvalidSigCode, line.SigCode)
			}
			changed, created, err := applyPasteLine(tx, tenant, cmd, line, batch, now)
			if err != nil {
				return err
			}
			if created {
				result.Created++
			} else if changed {
				result.Updated++
			}
		}
		return nil
	})
	if err != nil {
		return store.PasteResult{}, err
	}
	return result, nil
}

func applyPasteLine(tx *sql.Tx, tenant store.TenantID, cmd store.PasteCommand, line store.PasteLine, batch string, now int64) (changed, created bool, err error) {
	existing, err := scanSignature(tx.QueryRow(
		`SELECT `+signatureColumns+` FROM signature WHERE tenant_id = ? AND system_id = ? AND sig_code = ?`,
		int64(tenant), int64(cmd.SystemID), line.SigCode))
	switch {
	case errors.Is(err, sql.ErrNoRows):
		created, err = insertPastedSignature(tx, tenant, cmd, line, batch, now)
		return created, created, err
	case err != nil:
		return false, false, fmt.Errorf("sqlite: match signature: %w", err)
	}
	changed, err = updatePastedSignature(tx, tenant, cmd, existing, line, batch, now)
	return changed, false, err
}

func insertPastedSignature(tx *sql.Tx, tenant store.TenantID, cmd store.PasteCommand, line store.PasteLine, batch string, now int64) (bool, error) {
	scanKind := line.ScanKind
	if scanKind == "" {
		scanKind = "signature"
	}
	group := line.SiteGroup
	if group == "" {
		group = "unknown"
	}
	var whType *string
	if line.WHTypeCode != "" {
		whType = &line.WHTypeCode
	}
	res, err := tx.Exec(
		`INSERT INTO signature (tenant_id, system_id, sig_code, scan_kind, site_group, site_name, name_source, wh_type_code,
		 created_at, created_by, modified_at, modified_by, version)
		 VALUES (?, ?, ?, ?, ?, ?, 'paste', ?, ?, ?, ?, ?, 1)`,
		int64(tenant), int64(cmd.SystemID), line.SigCode, scanKind, group, line.SiteName, whType,
		now, cmd.Actor.CharacterID, now, cmd.Actor.CharacterID)
	if err != nil {
		return false, fmt.Errorf("sqlite: insert signature: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return false, fmt.Errorf("sqlite: signature id: %w", err)
	}
	after := map[string]any{
		"system_id": int64(cmd.SystemID), "sig_code": line.SigCode, "scan_kind": scanKind,
		"site_group": group, "site_name": line.SiteName, "name_source": "paste", "wh_type_code": whType, "version": int64(1),
	}
	if err := appendChange(tx, changeEntry{
		tenant: tenant, batchID: batch, at: now, actor: cmd.Actor,
		entity: "signature", entityID: id, op: "create", after: after,
	}); err != nil {
		return false, err
	}
	if group == "wormhole" {
		if err := insertWormholeConnection(tx, tenant, cmd, id, batch, now); err != nil {
			return false, err
		}
	}
	return true, nil
}

func insertWormholeConnection(tx *sql.Tx, tenant store.TenantID, cmd store.PasteCommand, sigID int64, batch string, now int64) error {
	res, err := tx.Exec(
		`INSERT INTO connection (tenant_id, kind, sig_a_id, system_a_id, leads_to_source, lifetime_source, size, size_source,
		 life_stage, life_stage_at, life_source, mass_status, created_at, created_by, modified_at, modified_by, version)
		 VALUES (?, 'wormhole', ?, ?, 'auto', 'auto', 'unknown', 'auto', 2, ?, 'default', 'fresh', ?, ?, ?, ?, 1)`,
		int64(tenant), sigID, int64(cmd.SystemID), now, now, cmd.Actor.CharacterID, now, cmd.Actor.CharacterID)
	if err != nil {
		return fmt.Errorf("sqlite: insert connection: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return fmt.Errorf("sqlite: connection id: %w", err)
	}
	return appendChange(tx, changeEntry{
		tenant: tenant, batchID: batch, at: now, actor: cmd.Actor,
		entity: "connection", entityID: id, op: "create",
		after: map[string]any{
			"kind": "wormhole", "sig_a_id": sigID, "system_a_id": int64(cmd.SystemID),
			"life_stage": 2, "mass_status": "fresh", "version": int64(1),
		},
	})
}

func updatePastedSignature(tx *sql.Tx, tenant store.TenantID, cmd store.PasteCommand, existing store.Signature, line store.PasteLine, batch string, now int64) (bool, error) {
	updated := existing
	before := map[string]any{}
	after := map[string]any{}
	if line.ScanKind != "" && line.ScanKind != existing.ScanKind {
		updated.ScanKind = line.ScanKind
		before["scan_kind"], after["scan_kind"] = existing.ScanKind, line.ScanKind
	}
	if !isUnknownGroup(line.SiteGroup) && line.SiteGroup != existing.SiteGroup {
		updated.SiteGroup = line.SiteGroup
		before["site_group"], after["site_group"] = existing.SiteGroup, line.SiteGroup
	}
	nameFillable := existing.SiteName == "" || existing.NameSource == "paste"
	if line.SiteName != "" && nameFillable && line.SiteName != existing.SiteName {
		updated.SiteName = line.SiteName
		before["site_name"], after["site_name"] = existing.SiteName, line.SiteName
	}
	if len(after) > 0 {
		updated.Version = existing.Version + 1
		before["version"], after["version"] = existing.Version, updated.Version
		_, err := tx.Exec(
			`UPDATE signature SET scan_kind = ?, site_group = ?, site_name = ?, version = ?, modified_at = ?, modified_by = ?
			 WHERE id = ? AND tenant_id = ?`,
			updated.ScanKind, updated.SiteGroup, updated.SiteName, updated.Version, now, cmd.Actor.CharacterID,
			existing.ID, int64(tenant))
		if err != nil {
			return false, fmt.Errorf("sqlite: update signature: %w", err)
		}
		if err := appendChange(tx, changeEntry{
			tenant: tenant, batchID: batch, at: now, actor: cmd.Actor,
			entity: "signature", entityID: existing.ID, op: "update", before: before, after: after,
		}); err != nil {
			return false, err
		}
	}
	if updated.SiteGroup != "wormhole" {
		return len(after) > 0, nil
	}
	added, err := ensureWormholeConnection(tx, tenant, cmd, existing.ID, batch, now)
	return len(after) > 0 || added, err
}

func ensureWormholeConnection(tx *sql.Tx, tenant store.TenantID, cmd store.PasteCommand, sigID int64, batch string, now int64) (bool, error) {
	var owned int
	err := tx.QueryRow(
		`SELECT COUNT(*) FROM connection WHERE tenant_id = ? AND (sig_a_id = ? OR sig_b_id = ?)`,
		int64(tenant), sigID, sigID).Scan(&owned)
	if err != nil {
		return false, fmt.Errorf("sqlite: check connection: %w", err)
	}
	if owned > 0 {
		return false, nil
	}
	return true, insertWormholeConnection(tx, tenant, cmd, sigID, batch, now)
}
