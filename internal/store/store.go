package store

import "context"

type TenantID int64

type SystemID int64

type Actor struct {
	CharacterID int64
	Name        string
}

type PasteLine struct {
	SigCode    string
	ScanKind   string
	SiteGroup  string
	SiteName   string
	WHTypeCode string
}

type PasteCommand struct {
	SystemID SystemID
	Actor    Actor
	Lines    []PasteLine
}

type PasteResult struct {
	BatchID string
	Created int
	Updated int
}

type SignaturePatch struct {
	ExpectedVersion int64
	SiteGroup       *string
	SiteName        *string
	WHTypeCode      *string
}

type JumpEntry struct {
	ConnectionID  int64
	CharacterID   int64
	CharacterName string
	ShipTypeID    int64
	BaseMass      int64
	Higgs         bool
	Hot           bool
	PropModTypeID *int64
	MassOverride  *int64
	EffectiveMass int64
	FromSystemID  SystemID
	Source        string
}

type Signature struct {
	ID         int64
	TenantID   TenantID
	SystemID   SystemID
	SigCode    *string
	ScanKind   string
	SiteGroup  string
	SiteName   string
	NameSource string
	WHTypeCode *string
	ExpiresAt  *int64
	Version    int64
}

type Connection struct {
	ID         int64
	TenantID   TenantID
	Kind       string
	SigAID     *int64
	SystemAID  SystemID
	SigBID     *int64
	SystemBID  *SystemID
	MassStatus string
	Version    int64
}

type TenantSnapshot struct {
	TenantID    TenantID
	Signatures  []Signature
	Connections []Connection
}

type SignatureRepository interface {
	ApplyPaste(ctx context.Context, tenant TenantID, cmd PasteCommand) (PasteResult, error)
	PatchSignature(ctx context.Context, tenant TenantID, signatureID int64, actor Actor, patch SignaturePatch) (Signature, error)
}

type JumpRepository interface {
	LogJump(ctx context.Context, tenant TenantID, actor Actor, entry JumpEntry) error
}

type SnapshotReader interface {
	ReadSnapshot(ctx context.Context, tenant TenantID) (TenantSnapshot, error)
}
