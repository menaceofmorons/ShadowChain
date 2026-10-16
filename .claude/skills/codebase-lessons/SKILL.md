---
name: codebase-lessons
description: Curated, reusable lessons about this codebase (build quirks, conventions, gotchas) accumulated across work streams. Preloaded into package agents; read-only for them, curated by the Team Lead.
user-invocable: false
metadata:
  source: codebase-lessons template v5.0
---

## Codebase Lessons
**Rules for agents:**
- Apply these when relevant.
- Never edit this file; report new lessons in your handover's Lessons section.

**Rules for the Team Lead (curator):**
- One line per lesson, tagged with the source work stream.
- Keep only reusable, codebase-level lessons; remove superseded or duplicate lines.
- Keep the file under 80 lines.
- This file merges with `merge=union`, so dedupe at release.

### Build & Tooling
- `web/` toolchain majors: Vite 8, Vitest 5, ESLint 10, TypeScript 6, React 19; check APIs against these versions (WS-1.1)
- Fresh worktrees have no `web/node_modules`; run `npm install --prefix web` before build or tests (WS-1.1)

### Conventions
- {lesson} (WS-x.y)

### Gotchas
- Agent worktree shells reject compound commands (`cd …`, chains, heredocs); use Write/Edit tools and single `npm --prefix web` calls (WS-1.1)
