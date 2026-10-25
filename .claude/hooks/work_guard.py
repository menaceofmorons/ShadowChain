#!/usr/bin/env python3
import json, re, sys

READ_TOOLS = ("Read", "Grep", "Glob")
PROTECTED = re.compile(r"(^|/)(_work(/|$)|00_Ownership\.md($|\s))")

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

if data.get("tool_name") not in READ_TOOLS:
    sys.exit(0)
if str(data.get("agent_type") or "").startswith("dd-"):
    sys.exit(0)

tool_input = data.get("tool_input") or {}
target = " ".join(str(tool_input.get(key) or "") for key in ("file_path", "path", "pattern", "glob")).replace("\\", "/")
if PROTECTED.search(target):
    print("Excluded: _work/ and 00_Ownership.md are readable only by the T-DD agents (dd-*).", file=sys.stderr)
    sys.exit(2)
sys.exit(0)
