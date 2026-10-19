package sqlite

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

func (s *Store) LogJump(ctx context.Context, tenant store.TenantID, actor store.Actor, entry store.JumpEntry) error {
	return s.execute(ctx, func(tx *sql.Tx) error {
		var version int64
		err := tx.QueryRow(`SELECT version FROM connection WHERE id = ? AND tenant_id = ?`,
			entry.ConnectionID, int64(tenant)).Scan(&version)
		if err == sql.ErrNoRows {
			return store.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("sqlite: load connection: %w", err)
		}
		now := s.now().Unix()
		res, err := tx.Exec(
			`INSERT INTO jump_log (tenant_id, connection_id, jumped_at, character_id, character_name, ship_type_id, base_mass,
			 higgs, hot, prop_mod_type_id, mass_override, effective_mass, from_system_id, source)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			int64(tenant), entry.ConnectionID, now, entry.CharacterID, entry.CharacterName, entry.ShipTypeID, entry.BaseMass,
			boolInt(entry.Higgs), boolInt(entry.Hot), entry.PropModTypeID, entry.MassOverride, entry.EffectiveMass,
			int64(entry.FromSystemID), entry.Source)
		if err != nil {
			return fmt.Errorf("sqlite: insert jump: %w", err)
		}
		jumpID, err := res.LastInsertId()
		if err != nil {
			return fmt.Errorf("sqlite: jump id: %w", err)
		}
		_, err = tx.Exec(
			`UPDATE connection SET version = version + 1, modified_at = ?, modified_by = ? WHERE id = ? AND tenant_id = ?`,
			now, actor.CharacterID, entry.ConnectionID, int64(tenant))
		if err != nil {
			return fmt.Errorf("sqlite: update connection: %w", err)
		}
		batch, err := newBatchID()
		if err != nil {
			return err
		}
		if err := appendChange(tx, changeEntry{
			tenant: tenant, batchID: batch, at: now, actor: actor,
			entity: "jump", entityID: jumpID, op: "create",
			after: map[string]any{
				"connection_id": entry.ConnectionID, "character_id": entry.CharacterID,
				"effective_mass": entry.EffectiveMass, "from_system_id": int64(entry.FromSystemID), "source": entry.Source,
			},
		}); err != nil {
			return err
		}
		return appendChange(tx, changeEntry{
			tenant: tenant, batchID: batch, at: now, actor: actor,
			entity: "connection", entityID: entry.ConnectionID, op: "update",
			before: map[string]any{"version": version},
			after:  map[string]any{"version": version + 1},
		})
	})
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
