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
- `web` has no `@types/node`; read source files in tests via Vite `import.meta.glob(..., {query: "?raw"})`, not `node:fs` (WS-1.1)
- golangci-lint 2.x config (`.golangci.yml`) requires `version: "2"` (WS-1.6)
- `gofmt -l` flags every Go file on Windows (CRLF checkout); rely on golangci-lint instead (WS-1.6)
- Go `-race` is unavailable on this machine (no cgo) (WS-1.6)
- `go/parser.ParseDir` is deprecated; walk `os.ReadDir` and call `parser.ParseFile` (WS-1.6)
- Go 1.27 has `sync.WaitGroup.Go`; use it for goroutine fan-out (WS-1.6)
- `cmd/loadtest` full profile takes ~10 min; run seeds sequentially so runs don't distort each other's latency (WS-1.6)
- Agent shells block foreground `sleep`; for a long wait use `ping -n N 127.0.0.1` (WS-1.6)

### Conventions
- {lesson} (WS-x.y)

### Gotchas
- Vite denies `?raw` imports of dotfiles (e.g. `web/.npmrc`); tests cannot read them that way (WS-1.1)
- modernc.org/sqlite applies DSN `_pragma=` params on every new pool connection; no ConnectHook needed for pool-wide pragmas (WS-1.6)
- SQLite DSN on Windows: build with `url.URL{Scheme: "file", Opaque: slashPath}` (WS-1.6)
- Windows clock resolution can yield 0 durations for fast queries; assert latency `>= 0`, not `> 0` (WS-1.6)
- `internal/store/sqlite` tests use both `sqlite` (internal) and `sqlite_test` packages; helpers such as `countRows` exist only in the internal one (WS-1.6)
- Only `sqlite.Store`'s writer goroutine may use `DB.Writer()`; the one-connection writer pool is shared by nothing else (WS-1.6)
- Vitest shows test `console.info` output only with `--reporter=verbose` (WS-1.1)
- React Flow in jsdom renders edges only if nodes set `initialWidth`, `initialHeight` and `handles`; ResizeObserver/offset stubs alone are not enough (WS-1.1)
- Vitest jsdom browser-API stubs must be set on both `window` and `globalThis` (WS-1.1)
- Agent worktree shells reject compound commands (`cd …`, chains, heredocs); use Write/Edit tools and single `npm --prefix web` calls (WS-1.1)
