#!/usr/bin/env python3
"""PreToolUse hook for the Team Lead (main session only, only while a #T-TLO run is active).
Active when <project>/.claude/tlo-active exists (created by the lead at start, gitignored).
Subagent calls (agent_id present) and ordinary sessions (no marker) pass straight through.
Blocks: code edits, spawning agents outside the allowlist, reading the dense design shards.
Exit 2 = block (stderr goes to the lead)."""
import json, os, re, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if data.get("agent_id"):
    sys.exit(0)
proj = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or "."
if not os.path.exists(os.path.join(proj, ".claude", "tlo-active")):
    sys.exit(0)

tool = data.get("tool_name") or ""
ti = data.get("tool_input") or {}

def norm(p):
    return (p or "").replace("\\", "/")

def block(msg):
    print(f"Team Lead guard: {msg}", file=sys.stderr)
    sys.exit(2)

ALLOWED_AGENTS = {"pkg-developer", "pkg-integrator", "pkg-analyst", "health-check", "code-reviewer"}
WRITE_OK = (
    r"/Execution-Ledger-[^/]+\.md$",
    r"/Package-Implementation-Plan-[^/]+(?<!-Baseline)\.md$",
    r"/Plan-Changes-[^/]+\.md$",
    r"/Process-Feedback-[^/]+\.md$",
    r"/\.claude/skills/codebase-lessons/SKILL\.md$",
    r"/\.claude/tlo-active$",
)

if tool in ("Agent", "Task"):
    st = ti.get("subagent_type") or ""
    if st not in ALLOWED_AGENTS:
        block(f"spawn only {sorted(ALLOWED_AGENTS)}; '{st or 'default'}' is not allowed.")
elif tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
    p = norm(ti.get("file_path") or ti.get("notebook_path"))
    if not any(re.search(rx, p) for rx in WRITE_OK):
        block(f"the lead writes only the ledger, the active plan, its change log, process feedback and codebase-lessons; delegate changes to '{p}'.")
elif tool in ("Read", "Grep", "Glob"):
    joined = " ".join(norm(str(ti.get(k) or "")) for k in ("file_path", "path", "pattern", "glob"))
    if "Design_Spec_Dense" in joined:
        block("the lead does not read design shards; rely on the agent's BLOCKED options.")
sys.exit(0)
