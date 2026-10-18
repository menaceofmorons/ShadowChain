# Execution Config

Execution settings for the agent team. It lives **in the repo** at `.claude/execution-config.md`, so every worktree has it at the same relative path, and changes to commands are versioned and released with the code. It is read by the Team Lead (`#T-TLO`), the package agents and `health-check`.

Project variables (`#PN`, `#DP`, `#CP`) are **not** defined here; they come from `#NP`.

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

The tab is always `--sheet #WS_ID`.

## Worktree Setup
| Step | Command |
| --- | --- |
| deps-frontend | `npm install --prefix web` |
| deps-backend | `go mod download` |

## Package Test Commands (package agents / test-runner)
| Purpose | Command |
| --- | --- |
| Build | `npm run build --prefix web && go build ./...` |
| Unit tests (all) | `go test ./...` |
| Unit tests (filtered) | `go test ./internal/{package}/...` |
| Frontend tests | `npm run test --prefix web` |

## Health Checks (health-check)
| Name | Command | Scope |
| --- | --- | --- |
| build | `npm run build --prefix web && go build ./...` | wave, full |
| lint | `go vet ./... && golangci-lint run` | wave, full |
| frontend-lint | `npm run lint --prefix web && npm run typecheck --prefix web` | wave, full |
| type-drift | `tygo generate && git diff --exit-code -- web/src/api/types.gen.ts` | wave, full |
| unit-all | `go test ./... && npm run test --prefix web` | full |
| e2e | `npm run e2e --prefix web` | full |

_Source: Execution-Config-Template-v5.0_
