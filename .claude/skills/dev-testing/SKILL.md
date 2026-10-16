---
name: dev-testing
description: Package testing rules - automated tests, data isolation, the fix-attempt limit, and Developer Test Card authoring, format and versioning. Single source for these rules.
user-invocable: false
metadata:
  source: Testing-Guidelines-v5.0
---

## Layer 1: Automated (you own and execute)
- **Unit tests:** table-driven unit tests for pure rules; mock fixtures and property-based cases for isolated logic.
- **Data isolation:** every test run creates its own temporary data store (e.g. a temporary SQLite file) and seeds what it needs; e2e runs launch the app against a seeded temporary store too. Never use a shared or persistent database: the Developer's development database, test-card data, or production. Parallel agents and repeatable results depend on this.
- **Negative paths:** automated negative and isolation checks for every boundary the package owns.
- **Running tests:** run the tests your package adds plus any existing suite covering the code you touched. Use `test-runner` for full or verbose suites.
- **Automate first:** anything that can be verified automatically must be automated rather than put on a card.

### Fixing failing tests
- **Fix-attempt limit: 2 per failing test.** After the 2nd failed attempt, stop fixing; `package-rules` says what to return. This limit is separate from the Team Lead's package retries.
- Never weaken an assertion or change an Expected Result, unless it contradicts the design or WSPP. In that case correct it and record it under Deviations & Corrections in the handover.

## Layer 2: Developer Test Cards (you author; the Developer executes)
**When to author:** whenever a scenario genuinely cannot be automated. The brief's `Test card` is an entry-time estimate, not an instruction:
- **Estimate `Batch`/`Blocking`, but everything was automated:** don't author a card. Explain why in the handover's Test Card Outcome.
- **Estimate `None`, but a scenario can't be automated:** author the card. Record the mismatch in the Test Card Outcome.

Cards cover only verification that automation cannot do:
- **Visual and ergonomic:** UI layout flow, canvas smoothness, styling presets.
- **Environment and hardware:** OS security prompts, network configuration, live certificates.
- **Exploratory and packaging:** exploratory usage, multi-device sync, binary packaging.

**File and naming:** one file per package, holding all of its tests, at the brief's Card path: `Developer-Tests-{WS}.{K}.{x}.md`. `x` starts at `0`.

**Versioning (Changes Requested):** when a fix brief cites a card marked Changes Requested, write version `x+1` as a **complete replacement**:
- tests the Developer approved are carried over with their Approved tick intact;
- changed or new tests have Sign-Off reset.

The highest version is always self-contained. When you write version `x+1`, **move version `x` to the `Archive/` folder beside it**, so only the current card stays open.

**Rules for every test:**
- Give exact commands and steps, the expected output, and a plain-text explanation of what to do. Tests must be repeatable, observable, objective and executable; nothing left to guessing.
- **State-modifying tests** (env vars, DB contents, config files, app settings) must record the original state, execute, then restore it, with the rollback steps written out explicitly.
- Put every parameter, code snippet, script, command, and directory path to be copied or run in a fenced block.
- **Regression tag:** mark each test `Regression: Yes ({area})` when it verifies lasting behaviour that later work could break (e.g. canvas performance, tenant isolation, a core user flow). Mark `Regression: No` for one-off checks (a migration ran, first-run state) and setup or environment checks. The phase closeout reuses `Yes` tests whose area the phase touched.

**Card structure** (repeat per test, numbered sequentially):

```Markdown
# 1. {Test Name}
- **Objective:** [Goal of verification]
- **Setup:** [Environment launch commands, seed steps, client setup, record state]
- **Verification Script:** [Checklist of steps with expected visual/system reactions]
- **Rollback:** [If required, return to original state]
- **Regression:** Yes ({area}) / No
- **Sign-Off:** [ ] Approved / [ ] Changes Requested
```
