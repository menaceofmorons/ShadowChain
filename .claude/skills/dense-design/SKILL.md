---
name: dense-design
description: Rules for using the dense design spec (Design_Spec_Dense) as design authority when implementing packages.
user-invocable: false
metadata:
  source: dense-design-use-v5.0
---

## DENSE DESIGN USAGE
- **Design:** the brief's `Design:` path (`Design_Spec_Dense/`). Read-only. Authority: `project-rules` (Design authority).
- **What to load:** `00_Index.md`, `01_Core.md`, and only the shards your package's `Spec:` line declares. Never load `_work/`, `00_Ownership.md` or the source .docx.
- **Citing:** Cite design facts by § tag (e.g. `§5.4.2`). Never copy shard text into handovers or test cards.
- **Literals:** `LITERAL: Appendix/…` → open that file only when the package builds that artifact.
- **Missing facts:** If a fact is not in your loaded shards, find its owner via the Index and load that shard. If it is still missing, return `BLOCKED`. Never infer and never fill gaps.
- **Tags:**
  - `[OD-nn]` = open decision: implement only what is stated; return `BLOCKED` before choosing.
  - `[PROVISIONAL]` = build as a configurable default.
  - `[ACCEPTED]` = known limitation: do not fix.
- **Constraints:** `## Constraints & Exclusions` bullets are hard limits: never build excluded capability or speculative hooks.
- **Conflicts:** where the WSPP or existing code conflicts with the dense set, follow the dense set and report it in the handover; if that changes scope, return `BLOCKED`.
