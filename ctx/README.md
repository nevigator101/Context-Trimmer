# ctx

ctx measures what every new Claude Code session loads up front in a project: built-in tools, skills, plugins, MCP servers and memory files. It compares that against what the project actually uses, according to the project's own session transcripts, and shows the result in the terminal. Measurements use Claude Code's own `/context` command in headless mode. They make no model call and cost no quota.

It then writes a lean profile to the project's `.claude/settings.local.json`, using only entries it can undo: tool denies, plugins off, and skills set to name-only. Items used in the project's recent sessions are never switched off unless you confirm.

**Status: 0.1.0, milestone 4 (measure, report, plan, apply, undo, session start, re-enable, cross-project baseline, learned triggers).**

## Commands

| Command | What it does |
|---|---|
| `/ctx:setup` | Onboarding: describe the project, measure, plan, confirm groups, apply, verify |
| `/ctx:trim` | Re-plan and apply (setup without the describe step) |
| `/ctx:report` | The upfront breakdown for new sessions, what's switched off and where, usage over the last 10 sessions, and unused items costing 200 tokens or more |
| `/ctx:on <item>` | Switch an item back on (`/ctx:on artifact`) |
| `/ctx:off <item>` | Switch an item off (`/ctx:off cloudflare`) |
| `/ctx:undo [all]` | Restore the previous backup, or the original file |
| `/ctx:enable <item>` | Used by Claude: switches an item back on when a task needs it |
| `/ctx:global [undo]` | Cross-project baseline: plugins and skills used in only a few projects go off in your user settings and stay on in the projects that use them |
| `/ctx:auto on\|off` | Learned triggers: when a prompt clearly needs a switched-off item ("deploy with wrangler"), ctx switches it on before Claude reads the prompt |
| `/ctx:doctor` | Shows which `claude` binary is used, the settings files and their scopes, the transcript folders, how fresh the cache is, and whether the profile is in force |

The CLI can also be run directly: `node dist/ctx.mjs help`.

## Safety

- ctx only adds or removes the entries it owns. It records them in `~/.claude/ctx/projects/<hash>/applied.json`. Entries you wrote yourself are left alone.
- Every write is preceded by a backup, made atomically, and checked by re-reading. `undo` restores the file byte for byte, and `undo all` restores the original (or removes the file if it didn't exist).
- The protected list is never touched: Read, Edit, Write, Glob, Grep, Skill, ToolSearch, AskUserQuestion, Bash, Agent, and PowerShell on Windows when you use it.
- Settings in other scopes (user, project, managed) are not edited, with one exception: `/ctx:global` writes the entries it owns in `~/.claude/settings.json`, after you confirm them. If an item is switched off in user or shared project settings, `/ctx:on` adds an override in this project's `settings.local.json` and leaves the other file alone. Tool denies and managed settings can't be overridden; for those, ctx tells you the file and the key.

## Moving between projects

`/ctx:global` looks at the recent sessions of every project on this machine. It finds plugins and skills that only some projects use, for example a Cloudflare plugin used in one project. It proposes switching those off in your user settings (skills go to name-only, so they stay callable) and keeping them on in the projects that use them, through a local override. Items used by most projects stay on, and so does ctx itself. Built-in tools aren't trimmed globally, because a user-level deny can't be overridden in a project.

The project overrides are written first and the user settings last, so a failure never leaves a project without something it uses. `/ctx:global undo` removes exactly what ctx wrote and puts back any value it replaced. When a project needs an item later, `/ctx:on <item>` brings it back for that project only.

## Learned triggers (opt-in)

`/ctx:auto on` learns, from recent sessions in all projects, which words in your prompts came before each tool, plugin or skill was used. It also uses the item's own name and, for plugins, their skill names. After that, a UserPromptSubmit hook checks each prompt locally, with no model call. When the prompt clearly needs something ctx switched off in this project, the hook switches it back on, tells Claude why, and prints one line for you. A plugin brought back this way still needs `/reload-plugins` in the current session. The hook is silent otherwise and costs nothing in context. `/ctx:auto` shows the trigger words for everything that's off; `/ctx:auto off` stops it.

## Every new session

A SessionStart hook reads only cached data (about 160 ms, no measuring, no writes). When something is switched off in the project, it gives Claude a short list of what's off, with one line per item, under 400 tokens. It also prints one status line, such as `ctx: lean profile active (11.8K upfront, 24 items trimmed)`. In a large project with no profile, it suggests `/ctx:setup` instead.

When a task needs something from that list, Claude can switch it back on with `/ctx:enable`. If you agreed during setup (the allow rule `Skill(ctx:enable)`, undoable like every other ctx change), it does this without asking. A re-enabled item isn't trimmed again by the next `/ctx:trim`.

A SessionEnd hook refreshes the usage ledger in the background.

The plugin itself costs about 50 tokens per session: the `ctx:enable` line in the skill listing. Its other skills are user-only and aren't listed.

## Bringing things back mid-session

- **Skills:** they can be invoked by name at once.
- **Plugins:** run `/reload-plugins`.
- **Tools:** they can be called after about a second (`/ctx:on` waits for that and prints the tool's input schema), but they only show up in the tool list after `/clear` or in a new session.

## Requirements

- Node.js 20 or later on PATH.
- Claude Code. If the `claude` binary isn't on PATH, ctx looks in the usual install locations and inside the VS Code extension. Set `CTX_CLAUDE_BIN` to override.

## Data

ctx keeps its state in `~/.claude/ctx/`: measurements, the usage ledger, plans, the ownership records and backups, the project registry, and the trigger table. It reads `~/.claude.json` and never writes it. It writes projects' `.claude/settings.local.json`, and `~/.claude/settings.json` only through `/ctx:global`.

## Note on `/context` totals

In Claude Code 2.1.326, the headline total from `/context` doesn't go down when skills are overridden or plugins are switched off, even though the real request gets smaller. ctx detects this and reports a corrected total. It shows the raw `/context` number next to it.
