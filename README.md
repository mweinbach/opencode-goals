# opencode-goals

> Codex-style Goal Mode for [OpenCode](https://opencode.ai)

Persistent, session-scoped goal tracking with auto-continuation, token budgeting, and completion auditing.

## Features

- **Session-Scoped Goals**: One active goal per OpenCode session
- **Token Budgeting**: Optional hard cap with automatic `budget_limited` status
- **Auto-Continuation**: When a turn finishes and the goal is still active, the runtime automatically queues a continuation turn
- **Wall-Clock & Token Accounting**: Tracks elapsed time and token consumption via SDK messages API
- **Completion Audit Prompts**: Model is steered to perform rigorous completion verification before marking done
- **TUI Controls**: Create, replace, pause, resume, clear, and inspect goals from OpenCode's TUI

## Architecture

This plugin replicates Codex's goal mode within OpenCode's plugin boundaries:

```
src/
  index.ts              # Plugin entry point with hooks
  types.ts              # Core types (ThreadGoal, TokenUsage, etc.)
  db/
    connection.ts       # SQLite connection (bun:sqlite)
    schema.ts           # Table definitions + migrations
    goals.ts            # CRUD, accounting, concurrency, and budget transitions
  runtime/
    state.ts            # GoalRuntimeState + event handlers
    accounting.ts       # Token/wall-clock delta calculations
  prompts/
    builders.ts         # continuation.md + budget_limit.md templates
  tools/
    get_goal.ts         # get_goal model tool
    create_goal.ts      # create_goal model tool
    update_goal.ts      # update_goal model tool (complete only)
```

## Installation

### From npm (recommended)

Add the server/runtime plugin to your `opencode.json`:
```json
{
  "plugin": ["opencode-goals"]
}
```

Add the TUI plugin to your `tui.json`:
```json
{
  "plugin": ["opencode-goals"]
}
```

OpenCode auto-installs npm plugins on startup. The package exposes separate OpenCode entrypoints:

- `.` / `./server` for the server/runtime plugin and custom model tools
- `./tui` for the TUI plugin

### From local files

```bash
git clone https://github.com/mweinbach/opencode-goals.git
cd opencode-goals
npm install
npm run build
```

The checkout is already wired for local development:

- `.opencode/plugins/opencode-goals.ts` auto-loads the server/runtime plugin.
- `tui.json` explicitly loads `./src/tui.tsx` for TUI integration.

For a global local file install, copy the built entrypoints and register them explicitly:

```bash
cp dist/index.js ~/.config/opencode/plugins/opencode-goals.js
cp dist/tui.tsx ~/.config/opencode/plugins/opencode-goals-tui.tsx
```

Then add the TUI entry to `~/.config/opencode/tui.json`:
```json
{
  "plugin": [
    "./plugins/opencode-goals-tui.tsx"
  ]
}
```

## TUI Plugin

The TUI plugin (`tui.tsx`) adds visual goal tracking directly into OpenCode's terminal interface.

**Important:** TUI plugins must be explicitly registered in `tui.json`. They are NOT auto-discovered like server plugins.

### Installation

Via npm (package exports handle both server and TUI):
```json
// tui.json
{
  "plugin": ["opencode-goals"]
}
```

Or via file path:
```json
// tui.json
{
  "plugin": [
    "./plugins/opencode-goals-tui.tsx"
  ]
}
```

### Features

### Sidebar Widget
- **Active goal display** in the sidebar with status icon, objective, and progress
- **Token breakdown** showing non-cached input, cached input, and output separately
- **Token progress bar** only when a budget is set, showing budget utilization percentage
- **Time elapsed** counter
- **Summary actions**: Pause / Resume / Replace / Clear from the command palette

### Footer Status
- Minimal status line showing active goal, token usage, and elapsed time

### Command Palette
Press `Ctrl+P` or type `/` to access:
- `Goals: Create Goal` — Opens dialogs to set an objective and optional token budget. Blank budget means no budget.
- `Goals: Summary` or `/goal` — Opens the current goal summary/actions dialog
- `Goals: Pause/Resume Goal` — Toggle goal state
- `Goals: Clear Goal` — Remove the active goal

### Toast Notifications
- Goal created / paused / resumed / cleared
- Budget limit reached
- Auto-continuation events

## Usage

### Model Tools

The plugin registers three tools the model can call:

| Tool | Description |
|------|-------------|
| `get_goal` | Get current goal state including split token usage, time elapsed, and remaining budget when set |
| `create_goal` | Create a new goal (fails if one already exists). Params: `objective` (string, max 4000 chars), `token_budget` (optional positive int; omitted means no budget) |
| `update_goal` | **Complete only** — marks goal as achieved. Rejects other status changes. |

### TUI Commands

Create `.opencode/commands/goal.md` (included in this repo):

```
/goal                          # Show current goal status
/goal "Refactor auth module"   # Create a new goal
/goal create "Implement OAuth" # Explicit create
/goal create "Fix" --budget 5000
/goal pause
/goal resume
/goal clear
```

## Database

Stored at `~/.config/opencode/goals.db`:

```sql
thread_goals (
  thread_id PRIMARY KEY,
  goal_id,
  objective,
  status,
  token_budget,
  tokens_used,
  input_tokens_used,
  cached_input_tokens_used,
  output_tokens_used,
  time_used_seconds,
  created_at_ms,
  updated_at_ms
)
```

The plugin owns this table and does not couple to OpenCode's private internal database. Older local `session_goals` rows are copied into `thread_goals` on startup when present.

## Goal Lifecycle

```
User creates goal (/goal, TUI, or create_goal)
    ↓
Status: active → Auto-continuation on idle
    ↓
Token accounting after each tool execution
    ↓
Budget exceeded? → Status: budget_limited + steering prompt
    ↓
Model calls update_goal(status: complete)
    ↓
Goal removed after counters are returned to the model
```

## Prompt Engineering

Three carefully crafted prompt surfaces shape model behavior:

### 1. Continuation Prompt
Auto-injected when session is idle and goal is active. Includes:
- `<untrusted_objective>` wrapper (XML-escaped, prevents prompt injection)
- Budget summary (time, tokens used, remaining)
- **Completion audit checklist**: model must verify every requirement against concrete evidence before marking complete

### 2. Budget Limit Prompt
Injected once when `tokens_used >= token_budget`. Instructs model to wrap up without starting new work.

### 3. Tool Descriptions
- `create_goal`: "Create a goal only when explicitly requested..."
- `update_goal`: "Use this tool only to mark the goal achieved..."
- Schema enforces `status: "complete"` as the only valid value

## OpenCode Limitations

This plugin operates within OpenCode's plugin API boundaries. These Codex features are approximated:

| Codex Feature | Plugin Approximation |
|---------------|----------------------|
| Turn start/finish hooks | `tool.execute.after` + `session.idle` |
| Interrupt → pause | Not detectable; use `/goal pause` or the TUI pause action |
| Native continuation turns | Simulated via `session.prompt()` |
| Invisible developer-role prompt injection | Simulated with plugin-safe session prompts |

## Development

```bash
npm install
npm run build    # Compile TypeScript
npm run dev      # Watch mode
npm test         # Typecheck, build, and run Bun tests
```

## License

MIT
