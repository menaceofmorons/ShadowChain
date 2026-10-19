package scenario

import (
	"fmt"
	"math"
	"math/rand/v2"

	"github.com/menaceofmorons/ShadowChain/cmd/loadtest/config"
	"github.com/menaceofmorons/ShadowChain/internal/store"
)

const (
	SystemsPerTenant   = 5
	BaseSystemID       = 30000000
	BaseCharacterID    = 90000000
	BurstPeriod        = 2
	BackgroundOpChance = 0.2
	JumpShare          = 0.7
	WarmupLines        = 10
	WarmupWormholes    = 5
	codeSpace          = 2000
	codeStride         = 7
	seedMix            = 0x9e3779b97f4a7c15
)

type OpKind string

const (
	OpPaste OpKind = "paste"
	OpJump  OpKind = "jump"
	OpPatch OpKind = "patch"
)

type Op struct {
	Kind      OpKind
	Tenant    int
	Character int
	System    store.SystemID
	Pick      int
	Lines     []store.PasteLine
}

type Window struct {
	Index      int
	Burst      bool
	Pastes     []Op
	Background []Op
}

var siteGroups = []string{"wormhole", "gas", "combat", "relic", "data", "ore", "unknown"}

func TenantID(tenant int) store.TenantID { return store.TenantID(tenant) }

func CharacterID(character int) int64 { return int64(BaseCharacterID + character) }

func SystemFor(tenant, index int) store.SystemID {
	return store.SystemID(BaseSystemID + (tenant-1)*SystemsPerTenant + index%SystemsPerTenant)
}

func CharacterTenant(character, tenants int) int { return (character-1)%tenants + 1 }

func sigCode(n int) string {
	n %= codeSpace
	return fmt.Sprintf("%c%cS-%03d", 'A'+n%26, 'A'+(n/26)%26, n%1000)
}

func lineFor(n int) store.PasteLine {
	n %= codeSpace
	group := siteGroups[n%len(siteGroups)]
	line := store.PasteLine{SigCode: sigCode(n), ScanKind: "signature", SiteGroup: group}
	switch group {
	case "wormhole":
		line.WHTypeCode = "K162"
	case "unknown":
	default:
		line.SiteName = fmt.Sprintf("Site %d", n)
	}
	return line
}

func pasteLines(rng *rand.Rand, size int) []store.PasteLine {
	start := rng.IntN(codeSpace)
	lines := make([]store.PasteLine, size)
	for i := range lines {
		lines[i] = lineFor(start + i*codeStride)
	}
	return lines
}

func WarmupPaste() []store.PasteLine {
	lines := make([]store.PasteLine, WarmupLines)
	for i := range lines {
		line := lineFor(i)
		if i < WarmupWormholes {
			line.SiteGroup = "wormhole"
			line.WHTypeCode = "K162"
			line.SiteName = ""
		} else if line.SiteGroup == "wormhole" || line.SiteGroup == "unknown" {
			line.SiteGroup = "gas"
			line.SiteName = fmt.Sprintf("Site %d", i)
			line.WHTypeCode = ""
		}
		lines[i] = line
	}
	return lines
}

func BurstTenantCount(p config.Profile) int {
	n := int(math.Round(p.BurstShare * float64(p.Tenants)))
	return min(max(n, 1), p.Tenants)
}

func newRand(seed uint64) *rand.Rand { return rand.New(rand.NewPCG(seed, seed^seedMix)) }

func drawPasteSize(rng *rand.Rand, p config.Profile) int {
	lo, hi := p.PasteSizeMin, p.PasteSizeMax
	if rng.Float64() < p.RarePasteShare {
		lo, hi = p.RarePasteSizeMin, p.RarePasteSizeMax
	}
	return lo + rng.IntN(hi-lo+1)
}

func BuildPlan(p config.Profile, windows int) []Window {
	rng := newRand(p.Seed)
	plan := make([]Window, windows)
	burstCount := BurstTenantCount(p)
	for i := range plan {
		w := Window{Index: i, Burst: i%BurstPeriod == 0}
		pasters := 1
		if w.Burst {
			pasters = burstCount
		}
		tenants := rng.Perm(p.Tenants)[:pasters]
		for _, t := range tenants {
			tenant := t + 1
			w.Pastes = append(w.Pastes, Op{
				Kind:      OpPaste,
				Tenant:    tenant,
				Character: tenant,
				System:    SystemFor(tenant, rng.IntN(SystemsPerTenant)),
				Lines:     pasteLines(rng, drawPasteSize(rng, p)),
			})
		}
		for c := 1; c <= p.Characters; c++ {
			if rng.Float64() >= BackgroundOpChance {
				continue
			}
			op := Op{Tenant: CharacterTenant(c, p.Tenants), Character: c, System: SystemFor(CharacterTenant(c, p.Tenants), 0)}
			if rng.Float64() < JumpShare {
				op.Kind, op.Pick = OpJump, rng.IntN(WarmupWormholes)
			} else {
				op.Kind, op.Pick = OpPatch, rng.IntN(WarmupLines)
			}
			w.Background = append(w.Background, op)
		}
		plan[i] = w
	}
	return plan
}
