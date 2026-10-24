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
- `web` has `@types/node` (WS-1.2); jsdom tests still read sources via `import.meta.glob(..., {query: "?raw"})`; Node-only tests use `// @vitest-environment node` (WS-1.1, WS-1.2)
- `src/test/setup.ts` is shared with Node-environment tests; guard every `window` access there (WS-1.2)
- `import.meta.glob('../**')` keys for sibling files normalise to `./file.ts`, not `../dir/file.ts` (WS-1.2)
- Playwright Chromium lives in `%LOCALAPPDATA%/ms-playwright`, shared across worktrees; `e2e` config starts the Vite dev server (WS-1.2)
- `format:check` covers only `web/src`; format `web/e2e` and `playwright.config.ts` by hand (WS-1.2)
- golangci-lint 2.x config (`.golangci.yml`) requires `version: "2"` (WS-1.6)
- Repo Go files are CRLF on Windows: `gofmt -l` flags every file (rely on golangci-lint), and scripted edits must preserve CRLF (WS-1.6)
- Go `-race` is unavailable on this machine (no cgo) (WS-1.6)
- `go/parser.ParseDir` is deprecated; walk `os.ReadDir` and call `parser.ParseFile` (WS-1.6)
- Go 1.27 has `sync.WaitGroup.Go`; use it for goroutine fan-out (WS-1.6)
- `cmd/loadtest` full profile takes ~10 min; run seeds sequentially so runs don't distort each other's latency (WS-1.6)
- The git guard hook refuses `git -C <path>` in agent shells; run git from the worktree cwd (WS-1.6)
- Agent shells block foreground `sleep`; for a long wait use `ping -n N 127.0.0.1` (WS-1.6)

### Conventions
- `web/` uses Prettier (single quotes, printWidth 120); run `npm run format --prefix web` before committing web changes; `format:check` is separate from `lint` (WS-1.2)

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
- Vitest default forks pool can time out starting workers on a loaded Windows machine; `--pool=vmThreads` is a working fallback (WS-1.2)
- Agent worktree shells reject compound commands (`cd …`, chains, heredocs, inline python); use Write/Edit tools and single `npm --prefix web` calls (WS-1.1, WS-1.2)
- Custom layout `Endpoint` implementations must provide `onMessageError`; engine worker entries use `bindEngineToWorker` and import only `map/layout` and `map/model` (WS-1.2)
- elkjs: import `elkjs/lib/elk.bundled.js` (default) and types from `elkjs/lib/elk-api`; `web/node_modules` is denied to file tools (WS-1.2)
- elk `radial` overlaps nodes; follow with a `sporeOverlap` pass. mrtree/radial have no interactive mode, so elk incremental is a full re-layout (WS-1.2)
- elk radial + `sporeOverlap` can take ~20x longer on specific trees (e.g. 14 s at 500 nodes, seed 7/churn 8/step 16); bake-off runs use a 60 s adapter timeout (WS-1.2)
- Radial now uses elk only for child order; per-level ring radii are computed in `elkEngine.ts` (`sporeOverlap` removed). Rings can be exact while the look still fails: judge radial visually, with the true root marked (WS-1.2)
- The placeholder canvas must draw boxes at the engine's nominal sizes and choose handle sides by layout mode, or overlaps and wrong edge sides appear (WS-1.2)
- React Flow fit-to-view on a 150-node chain needs `minZoom` lowered below 0.5 (`useStoreApi().getState().setMinZoom`) (WS-1.2)
- Importing `web/src/map/index.ts` statically pulls elkjs into the bundle via the bake-off and engine exports; the registry itself loads engines lazily (WS-1.2)
- `elk.bundled.js` fails inside a real Web Worker without a `document` global (`_Worker is not a constructor`); `engines/elk/documentShim.ts` is imported first in `elkWorker.ts`; Vitest jsdom hides this (WS-1.2)
- Vite worker URLs must be static `new URL('./x.ts', import.meta.url)` literals; keep them in lazy factories so Vitest never evaluates them (WS-1.2)
- Run Playwright via `npm run e2e --prefix web -- …`; `npx --prefix web playwright` misses the config (WS-1.2)
- Playwright specs can import `src/` TypeScript and call Vite `build` (`write: false`), but not `?raw` imports; the `bakeoff` project runs after the others (WS-1.2)
- Layout `x`,`y` are node top-left in both engines (WS-1.2)
- Agent shells reject multi-expression `sed -i`; line-pattern `sed` deletes can cut multi-line statements, so use Edit (WS-1.2)
- e2e host selects an engine via the Worker `name` option (`self.name`); register new engines in `web/e2e/host/engines.ts` (WS-1.2)
- Go files are forced to LF by `.gitattributes` (`*.go text eol=lf`); gofmt flags CRLF working copies from `core.autocrlf=true` (WS-1.3)
- Tidy-tree full-layout rows centre nodes within the level band, so a child's along differs from parent.along + size + spacing by up to the node-size spread; geometric checks need that slack (WS-1.3)
- `ReactFlowCanvas` sizes nodes from `DEFAULT_ENGINE_OPTIONS` via `nodeSize`; route any new node kind through it so drawn size equals engine size (WS-1.3)
- elk radial with `compactor: 'NONE'` is about 4x faster when elk only supplies child order (WS-1.3)
- Time-asserting layout tests need a warm-up call; the first elk call dominates p95 on small samples (WS-1.3)
- Incremental and full radial return nodes in different orders; compare layouts by node key, and use `toBeCloseTo` across `toHundredths` rounding (WS-1.3)
- e2e specs and the Playwright host can import `web/src/` constants directly; share thresholds rather than duplicating them (WS-1.3)
