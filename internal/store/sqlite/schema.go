package sqlite

import (
	"context"
	"database/sql"
	"fmt"
)

var testSchema = []string{
	`CREATE TABLE tenant (
		id INTEGER PRIMARY KEY
	) STRICT`,

	`CREATE TABLE signature (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		tenant_id INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
		system_id INTEGER NOT NULL,
		sig_code TEXT,
		scan_kind TEXT NOT NULL CHECK (scan_kind IN ('signature','anomaly')),
		site_group TEXT NOT NULL CHECK (site_group IN ('wormhole','combat','relic','data','gas','ore','unknown')),
		site_name TEXT NOT NULL,
		name_source TEXT NOT NULL CHECK (name_source IN ('paste','user')),
		wh_type_code TEXT,
		expires_at INTEGER,
		created_at INTEGER NOT NULL,
		created_by INTEGER NOT NULL,
		modified_at INTEGER NOT NULL,
		modified_by INTEGER NOT NULL,
		version INTEGER NOT NULL DEFAULT 1,
		UNIQUE (tenant_id, id)
	) STRICT`,
	`CREATE UNIQUE INDEX signature_tenant_system_code
		ON signature (tenant_id, system_id, sig_code) WHERE sig_code IS NOT NULL`,
	`CREATE INDEX signature_tenant_system ON signature (tenant_id, system_id)`,

	`CREATE TABLE connection (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		tenant_id INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('wormhole','gate','bridge')),
		sig_a_id INTEGER,
		system_a_id INTEGER NOT NULL,
		sig_b_id INTEGER,
		system_b_id INTEGER,
		leads_to TEXT,
		leads_to_source TEXT NOT NULL CHECK (leads_to_source IN ('auto','manual')),
		space TEXT,
		lifetime_min INTEGER,
		lifetime_source TEXT NOT NULL CHECK (lifetime_source IN ('auto','manual')),
		size TEXT NOT NULL CHECK (size IN ('small','medium','large','freighter','capital','unknown')),
		size_source TEXT NOT NULL CHECK (size_source IN ('auto','manual')),
		size_floor TEXT,
		life_stage INTEGER NOT NULL CHECK (life_stage BETWEEN 1 AND 4),
		life_stage_at INTEGER NOT NULL,
		life_source TEXT NOT NULL CHECK (life_source IN ('default','manual','auto')),
		mass_status TEXT NOT NULL CHECK (mass_status IN ('fresh','reduced','critical')),
		mass_manual INTEGER NOT NULL DEFAULT 0,
		permanent INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0,1)),
		note TEXT,
		evescout_sig TEXT,
		created_at INTEGER NOT NULL,
		created_by INTEGER NOT NULL,
		modified_at INTEGER NOT NULL,
		modified_by INTEGER NOT NULL,
		version INTEGER NOT NULL DEFAULT 1,
		UNIQUE (sig_a_id),
		UNIQUE (sig_b_id),
		UNIQUE (tenant_id, id),
		FOREIGN KEY (tenant_id, sig_a_id) REFERENCES signature (tenant_id, id) ON DELETE CASCADE,
		FOREIGN KEY (tenant_id, sig_b_id) REFERENCES signature (tenant_id, id) ON DELETE CASCADE,
		CHECK (kind <> 'wormhole' OR sig_a_id IS NOT NULL),
		CHECK (kind = 'wormhole' OR (sig_a_id IS NULL AND sig_b_id IS NULL AND system_b_id IS NOT NULL)),
		CHECK (kind <> 'bridge' OR permanent = 1),
		CHECK (kind = 'bridge' OR note IS NULL)
	) STRICT`,
	`CREATE INDEX connection_tenant_system_a ON connection (tenant_id, system_a_id)`,
	`CREATE INDEX connection_tenant_system_b ON connection (tenant_id, system_b_id)`,

	`CREATE TABLE jump_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		tenant_id INTEGER NOT NULL,
		connection_id INTEGER NOT NULL,
		jumped_at INTEGER NOT NULL,
		character_id INTEGER NOT NULL,
		character_name TEXT NOT NULL,
		ship_type_id INTEGER NOT NULL,
		base_mass INTEGER NOT NULL,
		higgs INTEGER NOT NULL CHECK (higgs IN (0,1)),
		hot INTEGER NOT NULL CHECK (hot IN (0,1)),
		prop_mod_type_id INTEGER,
		mass_override INTEGER,
		effective_mass INTEGER NOT NULL,
		from_system_id INTEGER NOT NULL,
		source TEXT NOT NULL CHECK (source IN ('tracked','manual')),
		FOREIGN KEY (tenant_id, connection_id) REFERENCES connection (tenant_id, id) ON DELETE CASCADE
	) STRICT`,
	`CREATE INDEX jump_log_tenant_connection ON jump_log (tenant_id, connection_id)`,

	`CREATE TABLE change_log (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		tenant_id INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
		batch_id TEXT NOT NULL,
		at INTEGER NOT NULL,
		actor_character_id INTEGER,
		actor_name TEXT NOT NULL,
		actor_account_id INTEGER,
		entity TEXT NOT NULL CHECK (entity IN ('signature','connection','jump','comment','chain_name','marker','marker_def','member','title_map','tenant','tenant_setting','discord_destination','ping')),
		entity_id INTEGER NOT NULL,
		op TEXT NOT NULL CHECK (op IN ('create','update','delete','expire','restore')),
		before_json TEXT,
		after_json TEXT
	) STRICT`,
	`CREATE INDEX change_log_tenant_at ON change_log (tenant_id, at)`,
	`CREATE INDEX change_log_tenant_actor_at ON change_log (tenant_id, actor_character_id, at)`,
	`CREATE INDEX change_log_batch ON change_log (batch_id)`,
}

func ApplyTestSchema(ctx context.Context, db *sql.DB) error {
	for _, stmt := range testSchema {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("sqlite: apply test schema: %w", err)
		}
	}
	return nil
}
