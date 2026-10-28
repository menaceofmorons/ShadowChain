# Execution Config

Execution settings for the agent team. It lives **in the repo** at `.claude/execution-config.md`, so every worktree has it at the same relative path, and changes to commands are versioned and released with the code. It is read by the Team Lead (`#T-TLO`), the package agents and `health-check`.

Project variables (`#PN`, `#DP`, `#CP`) are **not** defined here; they come from `#NP`.

Every command row names in `Requires` the repo-relative file whose presence makes the command valid, or `—` if it always applies. How a row whose file is absent is treated: `project-rules` (Execution Config rows).

One check per row. A row has one `Requires` path, so a command spanning two parts of the stack is split into two rows. Chain with `&&` only where a later step depends on an earlier one (e.g. generate, then diff), so one failure never hides another check's result.

## Settings
| Var | Value | Notes |
| --- | --- | --- |
| `#GR` | `develop` | Integration target branch |
| `#REMOTE` | `true` | `true` to fetch, pull and push `origin` |
| `#MAX_PARALLEL` | `2` | Max package agents running at once per Team Lead (throttle for plan usage limits) |

## Tracker Columns (`py tools/trkr_update.py`)
| Arg | Header in `#TRKR` |
| --- | --- |
| `--id-col` | `ID` |
| `--status-col` | `Status` |
| `--completed-col` | `Completed` |
| `--notes-col` | `Notes` |
| `--title-col` | `Title` |

The tab is always `--sheet #WS_ID`.

## Worktree Setup
Run by every agent in a fresh worktree, and by `health-check` before checks. Commands must be idempotent and quick when nothing has changed (prefer `npm install` to `npm ci`). Missing local files belong in `.worktreeinclude`.

| Step | Command | Requires |
| --- | --- | --- |
| deps-frontend | `npm install --prefix web` | `web/package.json` |
| deps-backend | `go mod download` | `go.mod` |

## Package Test Commands (package agents / test-runner)
| Purpose | Command | Requires |
| --- | --- | --- |
| Build (frontend) | `npm run build --prefix web` | `web/package.json` |
| Build (backend) | `go build ./...` | `go.mod` |
| Unit tests (all) | `go test ./...` | `go.mod` |
| Unit tests (filtered) | `go test ./internal/{package}/...` | `go.mod` |
| Frontend tests | `npm run test --prefix web` | `web/package.json` |

## Health Checks (health-check)
Scopes: `wave` per T-TLO §2.6; `full` per §2.7 and §3.

| Name | Command | Requires | Scope |
| --- | --- | --- | --- |
| build-web | `npm run build --prefix web` | `web/package.json` | wave, full |
| build-go | `go build ./...` | `go.mod` | wave, full |
| vet | `go vet ./...` | `go.mod` | wave, full |
| format-go | `py -c "import subprocess,sys;o=subprocess.run(['gofmt','-l','.'],capture_output=True,text=True).stdout;print(o);sys.exit(1 if o.strip() else 0)"` | `go.mod` | wave, full |
| golangci-lint | `golangci-lint run` | `go.mod` | wave, full |
| frontend-lint | `npm run lint --prefix web` | `web/package.json` | wave, full |
| format-web | `npm run format:check --prefix web` | `web/package.json` | wave, full |
| typecheck | `npm run typecheck --prefix web` | `web/package.json` | wave, full |
| type-drift | `tygo generate && git diff --exit-code -- web/src/api/types.gen.ts` | `tygo.yaml` | wave, full |
| unit-go | `go test ./...` | `go.mod` | full |
| unit-web | `npm run test --prefix web` | `web/package.json` | full |
| e2e | `npm run e2e --prefix web` | `web/playwright.config.ts` | full |

## Release (`#T-REL`, `#T-RS`)
| Var | Value | Notes |
| --- | --- | --- |
| `#BUILD` | `actions` | `#RWF` builds and publishes on tag push; written by `#T-RS workflow` |

### Version Files
| File | Pattern |
| --- | --- |
| `web/package.json` | `"version": "{v}"` |

### Release Build (`local` only)
| Step | Command |
| --- | --- |
| — | — |

### Publish Steps
| Step | Command or `manual` |
| --- | --- |
| GitHub Release | done by `#RWF` |
| `{TODO: deploy, if hosted}` | `{TODO}` |

_Source: Execution-Config-Template-v5.0_
