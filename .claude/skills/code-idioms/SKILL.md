---
name: code-idioms
description: Per-language idioms, conventions and language-boundary rules for this codebase, written by the Developer. Preloaded into package agents and the code reviewer; read-only for them.
user-invocable: false
metadata:
  source: code-idioms template
---

## Code Idioms
**Rules for agents:**
- Before changing files a Languages row matches, read its reference file; when a change touches a Boundaries row, read that file too. The files are in this skill's `references/` folder (`.claude/skills/code-idioms/references/`).
- `project-rules` wins where the two differ.

**Rules for the Developer (author):**
- Idioms, conventions and tool preferences only; build, test and lint commands stay in the Execution Config.
- Paraphrase outside sources; never copy their text or examples.
- Keep this body under 60 lines and each reference file under 150 lines.
- A `{placeholder}` row means no guidance yet.

### Languages
| Language | Globs | Reference |
| --- | --- | --- |
| {language} | `{glob}` | `references/{language}.md` |

### Boundaries
| Between | Files | Reference |
| --- | --- | --- |
| {language} and {language} | `{path}` | `references/{a}-{b}-boundary.md` |

### All languages
- {rule}
