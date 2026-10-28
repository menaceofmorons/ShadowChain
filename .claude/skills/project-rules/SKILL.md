---
name: project-rules
description: Project-wide rules for every session and agent - excluded directories, document versions, path format, working rules (design authority, path discipline, scope, answers, locks, worktree removal, Markdown, Execution Config rows, process feedback), protocol triggers, code comments. Preloaded into all agents; imported by CLAUDE.md; read first by CoWork.
user-invocable: false
metadata:
  source: project-rules template v5.0
---

## Project Rules
Single source for these rules. Package and check agents get this file preloaded; main sessions get it via an `@` import in CLAUDE.md. Edit here only.

### Excluded Directories
Never read, list or traverse these, at any depth. Exclude them inside every recursive command (`find`, `grep -r`, `ls -R`, globs). If a task genuinely needs one, stop and say so; agents return `BLOCKED`.

| Pattern | Why |
| --- | --- |
| `**/Archive/` | Retired documents |
| `**/Executed/` | Completed guides and plans |
| `**/Examples/` | Reference material, not project content |
| `**/_work/` | Design working files (T-DD agents only; guarded by `work_guard.py`) |
| `**/.git/` | Repository internals |
| `**/node_modules/` | Installed dependencies |
| `**/target/` | Rust build output (e.g. `src-tauri/target`) |
| `**/src-tauri/gen/` | Tauri-generated files |
| `**/web/dist/` | Vite build output (embedded into the binary) |
| `**/test-results/` | Playwright test output |
| `**/playwright-report/` | Playwright HTML report |

Target build output and generated folders, never source folders. The file-tool part of this list is mirrored as deny rules in `.claude/settings.json`, except `_work/`, which `.claude/hooks/work_guard.py` guards; keep them in step when you edit it.

### Documents and Paths
- **Versions:** always use the highest non-DRAFT version of any document. A path given in a brief or protocol step is used exactly as given.
- **Paths:** all paths use `/`, including Windows absolute paths (`C:/Users/…`).

### Working Rules
- **Design authority:** the approved dense design (`#DSD`) governs every plan, decision and change. On conflict, the design wins. Never plan, make or approve anything that contradicts it or adds architecture it does not define; if work seems to need that, stop and escalate (agents: `BLOCKED`; sessions: ask the Developer). The design changes only through `#T-DU`. Exception: in a standalone phase, a `#BRF` design change (`C-nn`) governs the § it names during its own work stream only, and reaches the design through `#T-DU` on acceptance. How to read it: `#DDU` (agents: `dense-design`).
- **Versions:** SemVer per `#NP`. A new major version (new roadmap) sets MAJOR; a release containing an Enhancement → MINOR; Bug fixes only → PATCH; alpha/beta → pre-release number only. Only `#T-REL` writes `main` and release tags.
- **Bug fixes:** reproduce first (agents: `dev-testing`; sessions: `#TG`).
- **Path discipline:** access only paths named by your session instructions, `#NP`, the active protocol or brief, or the Developer. No orientation scans.
- **Scope:** change only what the active plan, brief or Developer scopes; leave all other behaviour untouched.
- **Answers:** answer only what was asked, as briefly as the question allows. A yes/no question gets "Yes." or "No." plus at most one sentence; a choice gets the recommendation and the options in one or two lines. Give detail only when the Developer asks.
- **Locks:** on a read/write lock failure, retry once, then stop and report.
- **Worktrees:** remove a worktree only with `py tools/worktree_clean.py remove [--force] [--unlock] {path}` (Team Lead and Developer only), and clear leftovers with `py tools/worktree_clean.py sweep`. If `remove` or `sweep` reports a lock on a returned agent's worktree, add `--unlock` to `remove`. Never use bare `git worktree remove`: OneDrive marks folders read-only, which Windows won't delete, and the tool clears that first. If it still fails, report its output.
- **Execution Config rows:** a row in `.claude/execution-config.md` whose `Requires` file does not exist in your working directory does not apply. Skip it and report it as `N/A ({path} absent)`, never as a pass or a fail. Never create a `Requires` file unless your scope delivers it.
- **Markdown:** write each paragraph as one unwrapped line.
- **Process feedback:** a gap in the framework (a protocol, template, rule, hook or tool) is logged in `#FBK` only after the Developer has discussed it with you: state what happened and the proposed change, and write the entry once they agree. The Developer may also ask for any entry, noticed or not. The first entry creates the file from `#TPL/Process-Feedback-Template-vX.X.md`. Only append entries; never edit an existing one (the process Architect changes statuses), and never edit framework files. Package agents never write `#FBK`: they note a gap in their handover's Spillover as `Process: …` for the lead to raise.

### Protocols (main sessions only)
- `#T-{Name}` is Developer direction to run `#PROT/T-{Name}-vX.X.md` (top level only, case-insensitive). Read it once per session, plus only the files it names.
- No matching file: say so and stop. Never improvise a protocol.
- If its `Runs in:` excludes your tool (Chat, CoWork or Claude Code), stop and tell the Developer which tool to run it in.
- **Session check:** if it has a `Session:` line (a mode variant, e.g. `` `fix`: … ``, applies when the trigger carries that mode), before anything else reply only with this block, filled from that line, and start only on the Developer's `continue`; on `MISMATCH` or `unknown`, repeat it once on `continue`:

  ```
  Session check — #T-{Name}
  - Recommended: {Model}, effort {Level}
  - Running on: {model named in your system information, or "unknown"} → {OK | MISMATCH: switch to {Model} before continuing}
  - Effort cannot be verified: confirm it is set to {Level}.
  Reply "continue" to start.
  ```

### Code Comments
Code is self-documenting: clear names, small functions, explicit types. **The default is no comment.**

A comment is allowed only with one of these tags:
- `TEMP:` temporary code, plus the condition for removing it.
- `TUNE:` a tuned value or block, plus what it was tuned for.
- `WORKAROUND:` an external bug or platform quirk the code can't express, plus a reference (issue link or error).
- `REQUIRED:` a comment demanded by tooling, such as a lint suppression with its reason, or a licence header.

Doc comments that tooling requires (e.g. missing-docs lints) need no tag, but stay one line.

Never write:
- history ("changed from…", "previously…", "fixed bug where…");
- decision rationale or design discussion;
- restatements of what the code does;
- commented-out code;
- package or work stream IDs, authors or dates.

That information goes elsewhere:
- history goes in the **commit message**;
- decisions, deviations and design references go in the **handover**;
- reusable gotchas go in **Lessons**.

When editing, remove non-conforming comments **in the lines you change**. Don't sweep untouched code.
