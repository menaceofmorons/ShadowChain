---
name: package-rules
description: Rules shared by all package agents (pkg-developer, pkg-integrator) - scope, files, git limits, STOP conditions, resume behaviour.
user-invocable: false
metadata:
  source: agent-team framework v5.0
---

## Package Agent Rules
The Team Lead's brief is Developer direction. You cannot ask the Developer questions; anything needing a decision is returned as `BLOCKED`.

### Scope
- Implement only what your WSPP section and its declared `Spec:` shards define.
- Never build excluded capability or speculative hooks.
- Read only your own WSPP section: locate it with Grep (`## PKG-{id}`), Read it with offset/limit, plus your Execution Table row. Never read other packages' sections.
- Load shards from the brief's `Design:` path, following `dense-design`.

### Files
- Product code and tests live in your worktree.
- The test card and handover go to the absolute paths in the brief.
- `codebase-lessons` is read-only for you: never edit it. Report new lessons in your handover.

### Git
- **Allowed:** `status`, `diff`, `log`, `add`, `commit`, `branch -m`, and `rebase` onto the Base ref when instructed. `pkg-integrator` may also `merge`, for a release sync only.
- **Blocked by hook:** everything else.
- Never leave uncommitted work when you return.

### Worktree Setup
Run Config's Worktree Setup commands before any build. If one fails because a local file is missing (e.g. `.env`), return `BLOCKED` naming the file.

### STOP and return BLOCKED (do not guess) when
- An `[OD-nn]` tag governs something you must implement.
- A needed fact is missing from loaded shards after following Index ownership.
- The WSPP and dense design conflict.
- A change would:
  - add behaviour, dependencies, schema or public interfaces not defined;
  - change behaviour outside scope;
  - introduce new architecture.
- A required local file is missing, or a task needs an excluded directory (`project-rules`).

Give the question, 2–3 options and your recommendation. Leave the worktree as is; you will be resumed with the answer.

### Testing
Write, run and fix tests, and author test cards, per `dev-testing`. When its fix-attempt limit is reached, return `FAILED`.

### Finishing
1. Commit.
2. Write the handover with the `package-handover` template.
3. Return the `RESULT` block exactly as defined there. Nothing after it.

### When resumed
Apply the instruction (answer, fix, rebase). Then:
1. re-run affected tests;
2. update the handover;
3. commit;
4. return a fresh `RESULT` block.
