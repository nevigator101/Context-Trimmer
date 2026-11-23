# ctx

ctx measures what every new Claude Code session loads up front in a project: built-in tools, skills, plugins, MCP servers and memory files. It compares that against what the project actually uses, according to the project's own session transcripts, and shows the result in the terminal. Measurements use Claude Code's own `/context` command in headless mode. They make no model call and cost no quota.

It then writes a lean profile to the project's `.claude/settings.local.json`, using only entries it can undo: tool denies, plugins off, and skills set to name-only. Items used in the project's recent sessions are never switched off unless you confirm.

**Status: 0.1.0.** Clean install tested on Windows, macOS and Linux.

## Install

In Claude Code:

```
/plugin marketplace add nevigator101/Context-Trimmer
/plugin install ctx@ctx
```

Then open a project and run `/ctx:setup`. Nothing changes in any project until you confirm a plan there.

ctx needs Node.js 20 or later on PATH. Without Node, download the standalone build for your platform from the [releases page](https://github.com/nevigator101/Context-Trimmer/releases) (`ctx-windows-x64.exe`, `ctx-darwin-arm64`, `ctx-linux-x64`, ...). Put it in `~/.claude/ctx/bin/` (on macOS and Linux, `chmod +x` it). The plugin's launcher uses Node when it finds it, and the standalone build otherwise. If it finds neither, it prints one line at session start and stays out of the way.

## What it looks like

These samples come from a scratch project with six recorded sessions that used only the basic file and shell tools and, once, the watch plugin (`test/e2e/demo.mjs` regenerates them). `/ctx:setup` shows the plan and asks which groups to apply:

```
ctx plan: ~/code/demo-app   (untrimmed 32.6K, usage window 6 sessions)

[tools] Deny unused built-in tools   est. -21.9K
  tool:Artifact                           18.8K  off   never used
  tool:ScheduleWakeup                      1.7K  off   never used
  tool:ReportFindings                      0.8K  off   never used
  tool:ListAgents                          0.4K  off   never used
  skill:loop                               0.1K  soft  goes with tool:ScheduleWakeup (dependency)
  skill:artifact-design                    0.1K  soft  goes with tool:Artifact (dependency)
  skill:artifact-diagramming               0.1K  soft  goes with tool:Artifact (dependency)

[plugins] Switch off plugins not used here   est. -1.4K
  plugin:cloudflare@cloudflare             1.4K  off   never used

[skills] Unused skills to name-only (still callable by name)   est. -1.4K
  skill:dataviz                            0.5K  soft  never used
  skill:claude-api                         0.4K  soft  never used
  skill:code-review                        0.3K  soft  never used
  skill:update-config                      0.2K  soft  never used

Kept on: watch@claude-video (used) · Agent (protected) · AskUserQuestion (protected)
         Bash (protected) · Edit (protected) · Glob (protected) · Grep (protected)
         Read (protected) · Write (protected)
```

Applying it ends with one verification run:

```
Upfront context for new sessions: 32.6K -> 8.1K (untrimmed 32.6K); /context will show 11.1K.
Start a new session (/clear or a new chat) to use it. This session keeps the tools it started with.
```

`/ctx:report` at any time:

```
ctx report: ~/code/demo-app   (Claude Code 2.1.326, measured 2026-11-18)

Upfront per new session: 8.1K (untrimmed 32.6K, -75%)
  (/context shows 11.1K: its total doesn't subtract skill and plugin trims.)
  System prompt        2.0K
  Built-in tools       5.3K   deny saves: Agent 1.8K · Bash 1.3K · Grep 1.1K · Read 0.8K · Edit 0.7K
                              Glob 0.3K · ...
  Skills               0.7K   7 name-only
  MCP                  0.0K
  Memory files         0.1K   1 file

Switched off:  tool Artifact (18.8K) · tool ScheduleWakeup (1.7K) · tool ReportFindings (0.8K)
               tool ListAgents (0.4K) · plugin cloudflare (1.4K)
Usage, last 6 sessions (sessions used): Read 6 · Edit 6 · Bash 6 · Grep 6 · Glob 6 · Skill 1
  skill watch:watch 1 · Write 1
Suggestions: none above 200 tokens.
```

Your numbers depend on your plugins, skills and MCP servers; a setup with more extras saves more.

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

The CLI can also be run directly: `bin/ctx help` in the plugin folder.

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

- Node.js 20 or later on PATH, or the standalone build in `~/.claude/ctx/bin/` (see Install). `CTX_BIN` can point at a standalone build anywhere.
- Claude Code. Hooks and skills run the `bin/ctx` launcher through the shell Claude Code uses for commands (sh or bash; Git Bash on Windows).
- For measuring, ctx runs `claude` itself. If the binary isn't on PATH, ctx looks in the usual install locations and inside the VS Code extension. Set `CTX_CLAUDE_BIN` to override.
- The standalone builds aren't code-signed. Windows may warn the first time one runs; on macOS, remove the quarantine flag (`xattr -d com.apple.quarantine <file>`) if Gatekeeper blocks it.

## Data

ctx keeps its state in `~/.claude/ctx/`: measurements, the usage ledger, plans, the ownership records and backups, the project registry, and the trigger table. It reads `~/.claude.json` and never writes it. It writes projects' `.claude/settings.local.json`, and `~/.claude/settings.json` only through `/ctx:global`.

## Note on `/context` totals

In Claude Code 2.1.326, the headline total from `/context` doesn't go down when skills are overridden or plugins are switched off, even though the real request gets smaller. ctx detects this and reports a corrected total. It shows the raw `/context` number next to it.
