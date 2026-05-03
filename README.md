# opencode-goals

> Codex-style Goal Mode for [OpenCode](https://opencode.ai)

Persistent, session-scoped goal tracking with auto-continuation, token budgeting, and completion auditing.

## Features

- **Session-Scoped Goals**: One active goal per session with full archive history
- **Token Budgeting**: Optional hard cap with automatic `budget_limited` status
- **Auto-Continuation**: When a turn finishes and the goal is still active, the runtime automatically queues a continuation turn
- **Wall-Clock & Token Accounting**: Tracks elapsed time and token consumption via SDK messages API
- **Completion Audit Prompts**: Model is steered to perform rigorous completion verification before marking done
- **Archive/Resume**: Previous goals are archived; can be listed and resumed
- **CLI Wrapper**: Direct terminal commands without model involvement

## Architecture

This plugin replicates Codex's goal mode within OpenCode's plugin boundaries:

```
src/
  index.ts              # Plugin entry point with hooks
  cli.ts                # Standalone CLI binary
  types.ts              # Core types (ThreadGoal, TokenUsage, etc.)
  db/
    connection.ts       # SQLite connection (bun:sqlite)
    schema.ts           # Table definitions + migrations
    goals.ts            # Full CRUD (replicates goals.rs)
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

Add to your `opencode.json`:
```json
{
  "plugin": ["opencode-goals"]
}
```

Add to your `tui.json`:
```json
{
  "plugin": ["opencode-goals"]
}
```

OpenCode auto-installs npm plugins on startup.

### From local files

```bash
git clone https://github.com/mweinbach/opencode-goals.git
cd opencode-goals
npm install
npm run build

# For server plugin (auto-discovered from .opencode/plugins/)
cp .opencode/plugins/opencode-goals.ts ~/.config/opencode/plugins/

# For TUI plugin (must be listed in tui.json)
cp src/tui.tsx ~/.config/opencode/plugins/opencode-goals-tui.tsx
```

Then add to `~/.config/opencode/tui.json`:
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
- **Token progress bar** (when budget is set) showing usage percentage
- **Time elapsed** counter
- **Quick actions**: Pause / Resume / Clear buttons

### Footer Status
- Minimal status line showing active goal, token usage, and elapsed time

### Command Palette
Press `Ctrl+P` or type `/` to access:
- `Goals: Create Goal` — Opens dialog to set objective
- `Goals: Show Status` — Toast notification with full goal details
- `Goals: Pause/Resume Goal` — Toggle goal state
- `Goals: Clear Goal` — Archive and remove active goal
- `Goals: List Archived` — Show recent archived goals

### Toast Notifications
- Goal created / paused / resumed / cleared
- Budget limit reached
- Auto-continuation events

## Usage

### Model Tools

The plugin registers three tools the model can call:

| Tool | Description |
|------|-------------|
| `get_goal` | Get current goal state including tokens used, time elapsed, and remaining budget |
| `create_goal` | Create a new goal (fails if one already exists). Params: `objective` (string, max 4000 chars), `token_budget` (optional positive int) |
| `update_goal` | **Complete only** — marks goal as achieved. Rejects other status changes. |

### TUI Commands

Create `.opencode/commands/goal.md` (included in this repo):

```
/goal                          # Show current goal status
/goal "Refactor auth module"   # Create a new goal
/goal create "Implement OAuth" # Explicit create
```

### CLI Wrapper

For direct terminal control without model involvement:

```bash
# Install globally or use npx
npm link  # makes `goal` command available

# Commands
goal status                          # Show current goal
goal create "Refactor auth module"   # Create goal
goal create "Implement OAuth" --budget 10000
goal list                            # List active + archived goals
goal pause                           # Pause active goal
goal resume                          # Resume paused goal
goal clear                           # Clear current goal (archives it)
```

The CLI operates on the **same SQLite database** as the plugin (`~/.config/opencode/goals.db`), so changes are immediately visible to the model.

## Database

Stored at `~/.config/opencode/goals.db`:

```sql
-- Active goal (one per session, Codex exact)
session_goals (session_id PRIMARY KEY, directory, goal_id, objective,
               status, token_budget, tokens_used, time_used_seconds,
               created_at_ms, updated_at_ms)

-- Archived goals (Option B history)
goal_archive (id, session_id, directory, goal_id, objective,
              status, token_budget, tokens_used, time_used_seconds,
              created_at_ms, completed_at_ms, archived_at_ms)
```

## Goal Lifecycle

```
User creates goal (create_goal)
    ↓
Status: active → Auto-continuation on idle
    ↓
Token accounting after each tool execution
    ↓
Budget exceeded? → Status: budget_limited + steering prompt
    ↓
Model calls update_goal(status: complete)
    ↓
Goal archived, counters preserved
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
| Interrupt → pause | Not detectable; use `/goal pause` or CLI |
| Native continuation turns | Simulated via `session.prompt()` |
| TUI interactive menus | Static command templates only |

## Development

```bash
npm install
npm run build    # Compile TypeScript
npm run dev      # Watch mode
npm run cli      # Run CLI via bun
```

## License

MIT
