---
description: Create or manage a session goal for autonomous task pursuit
agent: build
---

$ARGUMENTS

The opencode-goals plugin handles this command before the model turn runs.
Use the command result above as the source of truth and summarize it directly.

Supported forms:
- `/goal` or `/goal status` shows current goal state.
- `/goal <objective>` creates a goal when none exists.
- `/goal create <objective> --budget <N>` creates a budgeted goal.
- `/goal pause` pauses an active goal.
- `/goal resume` resumes a paused goal.
- `/goal clear` clears the current goal.

Do not call goal tools again unless the command result explicitly asks you to.
