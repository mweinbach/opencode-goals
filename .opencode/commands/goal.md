---
description: Create or manage a session goal for autonomous task pursuit
agent: default
---

$ARGUMENTS

You MUST call the appropriate tool based on the arguments:

**If $ARGUMENTS is empty or just "status":**
Call `get_goal` tool immediately to show the user the current goal state.

**If $ARGUMENTS starts with "create " or is just a plain objective:**
Call `create_goal` tool with:
- objective = the goal text (strip "create " prefix if present)
- token_budget = only if the user explicitly mentions a budget number

**If $ARGUMENTS is "list" or "archive":**
Call `get_goal` tool to show current goal, then explain that archived goals can be viewed via the CLI (`goal list`).

**If $ARGUMENTS is "pause", "resume", or "clear":**
Explain that these operations should be done via the CLI command:
- `goal pause` — pause the active goal
- `goal resume` — resume a paused goal  
- `goal clear` — clear the current goal (archives it)

**Examples of what the user might type:**
- `/goal` → call get_goal
- `/goal Refactor auth module` → call create_goal with objective="Refactor auth module"
- `/goal create Implement OAuth with JWT` → call create_goal with objective="Implement OAuth with JWT"
- `/goal create Fix bugs --budget 5000` → call create_goal with objective="Fix bugs", token_budget=5000
- `/goal status` → call get_goal
- `/goal list` → call get_goal, then mention CLI

Do not ask clarifying questions. Just call the appropriate tool.
