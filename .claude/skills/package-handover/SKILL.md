---
name: package-handover
description: Package handover document template and the RESULT return contract every package agent must end with.
user-invocable: false
metadata:
  source: agent-team framework v5.0
---

## Handover file (write at the brief's Handover path)
Keep it under ~70 lines. It is read by the Team Lead, downstream packages, the integrator and `#T-WSExit`.

```Markdown
# Handover — PKG-{WS}.{K} — {Title}
**Branch:** package/{PKG}-{slug} @ {short sha} | **Base:** {base sha} | **Date:** {date}

## Delivered
- {Each WSPP acceptance criterion}: Met / Not met — {≤1 line evidence}

## Changes
- {path or module}: {≤1 line what/why}   (from `git diff --stat`; group by module)

## Contracts Exposed
- {public interface, type, endpoint, schema, event}: {signature or § ref}

## Tests
- Automated: {passed}/{total} — {suite names}
- Test card: {path | None}

## Test Card Outcome
- Estimate (WSPP): {None | Batch | Blocking} | Actual: {None | Card authored} | Why: {≤1 line — what could or could not be automated}

## Design References
- {§ tags relied on}

## Deviations & Corrections
- {Any corrected Expected Result, WSPP/design conflict reported, PROVISIONAL defaults chosen | None}

## Spillover
- {Edge cases, tech debt, deferred scope discovered | None}

## Lessons
- {Reusable, codebase-level finding a future package would otherwise rediscover (build quirk, convention, gotcha, tool behaviour). Not package-specific detail. | None}

## Notes for Integration
- {Wiring points, assumptions downstream packages must honour | None}
```

## RESULT block (the last thing you output; nothing after it)

```
RESULT: COMPLETE | BLOCKED | FAILED
PKG: PKG-{WS}.{K}
BRANCH: package/{PKG}-{slug} @ {short sha}
WORKTREE: {absolute worktree path}
TESTS: {passed}/{total} automated | card: {path | None}
HANDOVER: {path | not written}
SPILLOVER: {≤15 words | None}
ISSUE: {BLOCKED/FAILED only: one-line problem}
OPTIONS: {BLOCKED only: A) … B) … | Recommendation: X — reason}
```
