# ctx

ctx measures what every new Claude Code session loads up front in a project: built-in tools, skills, plugins, MCP servers and memory files. It compares that against what the project actually uses, according to the project's own session transcripts, and shows the result in the terminal. Measurements use Claude Code's own `/context` command in headless mode. They make no model call and cost no quota.

**Status: 0.1.0, milestone 1 (measure and report).** Trimming (`/ctx:setup`, `/ctx:trim`, `/ctx:on`, `/ctx:off`, `/ctx:undo`) comes in the next milestone.

## Commands

| Command | What it does |
|---|---|
| `/ctx:report` | The upfront breakdown for new sessions, what's switched off and where, usage over the last 10 sessions, and unused items costing 200 tokens or more |
| `/ctx:doctor` | Shows which `claude` binary is used, the settings files and their scopes, the transcript folders, and how fresh the cache is |

The CLI can also be run directly: `node dist/ctx.mjs measure --full | usage | report | doctor`.

## Requirements

- Node.js 20 or later on PATH.
- Claude Code. If the `claude` binary isn't on PATH, ctx looks in the usual install locations and inside the VS Code extension. Set `CTX_CLAUDE_BIN` to override.

## Data

ctx keeps its state in `~/.claude/ctx/` (measurements, usage ledger). It reads `~/.claude.json` and never writes it. In this version it doesn't change any settings files.

## Note on `/context` totals

In Claude Code 2.1.326, the headline total from `/context` doesn't go down when skills are overridden or plugins are switched off, even though the real request gets smaller. ctx detects this and reports a corrected total. It shows the raw `/context` number next to it.
