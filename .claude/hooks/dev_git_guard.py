#!/usr/bin/env python3
"""PreToolUse hook (Bash|PowerShell) for pkg-developer / pkg-integrator.
Blocks git operations reserved for the Team Lead. Exit 2 = block (stderr goes to the agent).
pkg-integrator may additionally run `git merge` (release sync only)."""
import json, re, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cmd = (data.get("tool_input") or {}).get("command") or ""
if not cmd:
    sys.exit(0)
agent = data.get("agent_type") or ""

scan = re.sub(r'"[^"]*"', '""', cmd)
scan = re.sub(r"'[^']*'", "''", scan)

G = r"\bgit\b[^;&|\n]*"
rules = [
    (G + r"\bpush\b", "git push is reserved for the Team Lead"),
    (G + r"\b(checkout|switch)\b", "do not change branches; work on your package branch only"),
    (G + r"\breset\b[^;&|\n]*--hard", "git reset --hard is not permitted"),
    (G + r"\bbranch\b[^;&|\n]*\s-(d|D)\b", "deleting branches is reserved for the Team Lead"),
    (G + r"\bworktree\b", "worktree management is reserved for the Team Lead"),
    (G + r"\s(-C|--git-dir|--work-tree)\b", "run git only in your own worktree"),
]
if agent != "pkg-integrator":
    rules.append((G + r"\bmerge(?!-base)\b", "git merge is reserved for the Team Lead"))

for pattern, why in rules:
    if re.search(pattern, scan):
        print(f"Blocked: {why}. If this is needed, return BLOCKED to the Team Lead.", file=sys.stderr)
        sys.exit(2)
sys.exit(0)
