# ctx: Lean-Context Plugin for Claude Code (Implementation Spec)

**Status:** ready for implementation · **Spec date:** 2026-11-18 · **Working name:** `ctx` (placeholder; the product name must not contain "Claude")

This spec is the full brief for building the plugin. Facts marked **[verified]** were measured on 2026-11-18 (Windows 11, Claude Code 2.1.326, model `claude-opus-5-5`). Items marked **[verify]** are assumptions: confirm them in Milestone 0 before building on them, and if one fails, use the fallback given next to it.

---

## 1. Goal

Make every new Claude Code session load only what the project needs. The plugin measures what each session loads up front (tools, skills, plugins, MCP, memory files) and checks it against what the project actually uses. It writes a lean per-project configuration, and it brings items back when a task needs them.

The intended user doesn't know which tools or skills are safe to turn off. The plugin decides from evidence: measured cost, recorded usage, and the user's description of the project. Every change is reversible.

### Success criteria

| # | Criterion | Target |
|---|---|---|
| S1 | Upfront tokens in a new session after `setup`, versus before | At least 30% lower on a typical multi-plugin setup (reference result: 30.6K → 16.7K, −45%) |
| S2 | Needed capability lost | Zero cases where a tool or skill used in the project's last 10 sessions is hard-disabled without the user confirming |
| S3 | Settings integrity | Zero corrupted or lost settings keys; every change is undoable byte for byte |
| S4 | Plugin's own context cost | Under 300 tokens per session when nothing is disabled; under 600 with the capability index |
| S5 | SessionStart hook latency | Under 300 ms (it must never run the measurement) |

### Non-goals (v1)

- No web UI, local server, proxy, Docker, database or telemetry backend.
- No network calls except the `claude` CLI itself.
- No editing of `CLAUDE.md` files. The plugin reports their size and suggests changes but never rewrites them.
- No automatic editing of `~/.claude.json`. MCP server toggles are proposed and the user applies them with `/mcp` (see §7.4).

---

## 2. Verified facts the design rests on

### 2.1 Measuring needs no proxy [verified]

`claude -p "/context"` run in a project directory prints a Markdown breakdown of the upfront context and exits. Passing `--settings '<json>'` applies extra settings to that run only, so one item's cost can be measured exactly by toggling it, without touching any file.

Gotchas found during measurement:

- On Git Bash, the argument `/context` is rewritten to `C:/Program Files/Git/context` unless `MSYS_NO_PATHCONV=1` is set. Spawn the process from Node **without a shell** (`child_process.spawn(bin, args, {shell: false})`) and the problem disappears.
- The `claude` executable may not be on PATH. On the reference machine it existed only inside the VS Code extension, at `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-<version>-win32-x64\resources\native-binary\claude.exe`. See §6.1.
- **[verified M0]** `-p "/context"` makes no model call and uses no quota (`total_cost_usd: 0`, `num_turns: 0`; about 4 s per run).
- **[verified M0]** `-p` runs do create transcripts. Always pass `--no-session-persistence` (the flag exists in 2.1.326). The ledger also skips sessions with no assistant turn.
- **[verified M0]** Spawn with stdin ignored (`stdio: ['ignore', 'pipe', 'pipe']`). Otherwise `-p` waits 3 s and prints a stdin warning that breaks `--output-format json`.
- **[verified M0] Skills quirk:** `/context`'s headline total doesn't change when skills are overridden or plugins are switched off. The Skills row drops and System tools rises by the same amount, while the real request does shrink (confirmed by request capture). Report `corrected = total − (Skills_reference − Skills_run)`. See VERIFY.md item 6.

### 2.2 Reference measurement (this project, before and after the manual trim) [verified]

| `/context` category | Before | After |
|---|---|---|
| System prompt | 2.9K | 2.6K |
| System tools (upfront) | 18.5K | 9.8K |
| MCP tools (upfront) | 0.67K | 0.67K |
| MCP server instructions | 0.72K | 0.72K |
| Memory files | 0.49K | 0.49K |
| Skills | 7.3K | 2.4K |
| **Total (headline `Tokens:`)** | **30.6K** | **16.7K** (corrected for the skills quirk: **11.8K**) |
| MCP tools (deferred, not in total) | 32.6K | 32.6K |
| System tools (deferred, not in total) | 20.8K | 14.2K |

The "after" configuration is the file in Appendix B.

### 2.3 Per-tool cost from single-tool deny runs [verified]

The "System tools" row was 18.5K with nothing denied. Each row below shows that number with only one tool denied.

| Denied tool | System tools | Delta |
|---|---|---|
| Artifact | 6.5K | **−12.0K** |
| Bash | 13.2K | −5.3K |
| PowerShell | 14.7K | −3.8K |
| ScheduleWakeup | 16.8K | −1.7K |
| Agent | 17.1K | −1.4K |
| Grep | 17.2K | −1.3K |
| ReportFindings | 17.7K | −0.8K |
| Read | 17.8K | −0.7K |
| ListAgents | 18.1K | −0.4K |
| Edit | 18.1K | −0.4K |
| Write, Glob | 18.2K | −0.3K each |
| AskUserQuestion | 18.5K | 0 (already deferred) |
| **Skill** | 28.8K | **+10.3K: never deny** |
| **ToolSearch** | 42.5K | **+24.0K: never deny** (switches off deferred loading) |

Combined denies don't add up exactly. Denying both Artifact and ScheduleWakeup cut 8.7K from the upfront category, and the deferred category also shrank. **Always confirm a profile with one full verification run**; never report the sum of single-item deltas as the result.

### 2.4 The levers [verified unless marked]

| Item | Lever | Where written | Effect |
|---|---|---|---|
| Built-in tool | `permissions.deny: ["<ToolName>"]` (bare name) | `.claude/settings.local.json` | Removes the tool from context **[verified]** |
| Plugin | `enabledPlugins: {"<plugin>@<marketplace>": false}` | `.claude/settings.local.json` | A project-local `false` overrides a user-level `true` **[verified]**. The reverse (user `false`, project `true`) also works **[verified M0]** |
| Skill (built-in, user, claude.ai-synced) | `skillOverrides: {"<short-name>": "name-only" \| "user-invocable-only" \| "off"}` | `.claude/settings.local.json` | `name-only` keeps the name visible and callable **[verified]**: short names work for synced skills, e.g. `"docx"`. Plugin skills **can't** be overridden: `"cloudflare:wrangler"`, `"wrangler"` and `"cloudflare@cloudflare:wrangler"` all have no effect **[verified M0]**. Their plugin is the only lever |
| MCP server | `/mcp` toggle → `disabledMcpServers` in the project entry of `~/.claude.json` | Done by the user through `/mcp` (v1) | MCP tools are deferred by default, so only names and server instructions cost tokens |
| `.mcp.json` server | `disabledMcpjsonServers: ["<name>"]` | `.claude/settings.local.json` | Rejects that project-defined server |

From the Claude Code docs (read 2026-11-18):

- Settings files are watched and hot-reloaded, including `permissions`.
- A bare-name deny added mid-session blocks the tool from the next call. **[verified M0]** *Removing* the deny mid-session makes the tool callable, but the tool is not added back to the tool list or to ToolSearch. `/clear` rebuilds the list; `/compact` doesn't (VERIFY.md item 9).
- With tool search on (the default), a mid-session deny leaves the request's tool definitions unchanged, so the cache survives but **no tokens are saved until the next session**. Trimming therefore targets new sessions.
- Plugin enable/disable applies through `/reload-plugins` (the doc says this works mid-session).
- Telemetry `env` variables are ignored in project and local settings; not needed in v1.

### 2.5 Usage evidence available without hooks [verified]

- `~/.claude.json` → `skillUsage: { "<skill>": { usageCount, lastUsedAt } }` and `pluginUsage: { "<plugin>@<marketplace>": { usageCount, lastUsedAt, lastUsedNumStartups } }`. These counters are **global**, not per project. Read only; never write this file.
- Session transcripts: `~/.claude/projects/<slug>/*.jsonl`, one file per session. The slug is the cwd with `:`, `\`, `/` and spaces replaced by `-` (e.g. `c--Users-Nev-Observibility-Proxy`). **Drive-letter case differs between sessions** (`c--…` and `C--…` both exist), so match case-insensitively and merge.
- In transcripts, assistant messages contain `tool_use` blocks. Read the following from them:
  - **Tool used:** `name`.
  - **Skill used:** `input.skill` when the name is `Skill`.
  - **Subagent used:** `input.subagent_type` when the name is `Agent`.
  - **MCP server used:** the `<server>` part of `mcp__<server>__<tool>`.
  - **Typed slash commands:** these appear in user messages as `<command-name>/x</command-name>`.
- **[verified M0]** Field paths are as above. `input.skill` may be qualified: claude.ai-synced skills appear as `anthropic-skills:<name>`, so strip that prefix. Keep the parser defensive.

---

## 3. User workflow

### 3.1 Install (once)

The user installs the plugin at user scope from its marketplace. Nothing else changes until they run setup in a project.

### 3.2 Project setup session: `/ctx:setup` (once per project)

This is the onboarding flow. The user runs it in a fresh session inside the project.

1. **Describe.** The skill asks Claude to read the repo briefly: README, package and manifest files, top-level folders. Claude then asks the user at most 3 questions with AskUserQuestion: what the project is, which external services it uses, and which kinds of work it expects (code only, docs, media, deploys). Output: `project-profile.json` (§5.4).
2. **Measure.** Run `ctx measure` (§6). It does a baseline `/context`, then single-item toggle runs for every built-in tool not on the protected list, every plugin, and every skill group. Results are cached by Claude Code version.
3. **Collect usage.** Run `ctx usage` (§7.1). It builds the ledger from this project's transcripts plus the global counters.
4. **Classify.** Run `ctx plan` (§7.2). Deterministic rules produce a draft. Claude then reviews the draft against the project description and may move items between classes, but never into "off" for anything protected or recently used. Output: a proposed profile with the token saving per item.
5. **Confirm.** Show the plan as a table, grouped, with savings. AskUserQuestion with multi-select groups (maximum 4 options per question; chain questions if needed).
6. **Apply.** Run `ctx apply` (§8). It does an atomic write of `.claude/settings.local.json` with a backup, followed by **one verification run** of `/context` to record the real new total.
7. **Hand-off message.** "Upfront context for new sessions: 30.6K → 16.7K. Start a new session (`/clear` or a new chat) to use the lean setup." The current session keeps its already-cached tools.

### 3.3 Every new session (automatic)

The `SessionStart` hook runs `ctx hook session-start`. It must be fast and use only cached data:

- If a profile is applied, add the **capability index** (§9.1) as `additionalContext`, but only when at least one item is hard-off.
- Print one `systemMessage` line when useful, e.g. `ctx: lean profile active (16.7K upfront, 8 items off). /ctx:report for details.`
- If the project has no profile and its measured upfront context is above a threshold (default 20K), print `ctx: this project loads 30.6K upfront; /ctx:setup could cut ~14K.`
- Never run measurements or write files in this hook.

### 3.4 Moving between projects

Project-specific extras (e.g. the Cloudflare plugin, used only in one other project) should not load everywhere.

- **Project scope first.** Every v1 change goes in that project's `.claude/settings.local.json`, so projects never affect each other.
- **Optional user-level lean baseline: `/ctx:global`.** It proposes switching rarely used plugins off and skills to name-only in `~/.claude/settings.json`, and switching them back on in the projects that use them, using per-project usage from transcripts. Example: Cloudflare is off globally and on in the Cloudflare project. **[verified M0 + M4]** A project-local `enabledPlugins: true` overrides user `false`, and a local `skillOverrides: "on"` overrides a user-level level, per key (VERIFY.md items 8, 26, 27).
  - **Classification (M4):** across projects with a session in the last 90 days (10 sessions each), an item used by more than half of them stays on ("common"); one used by fewer goes off with a local keep-on override in each using project ("extra"); one used nowhere goes off ("unused") unless the global counters show recent use ctx can't map to a project ("elsewhere"). Plugins under 200 tokens and skills under 50 are left alone. ctx itself and values the user set in user settings are never touched.
  - **Built-in tools are not trimmed globally:** a user-level deny can't be overridden per project.
  - **Writes, in order:** keep-on overrides in the projects first (harmless on their own), then user settings. An item whose override can't be written (e.g. invalid JSON in that project) stays on globally. Claude Code writes `enabledPlugins: {"x": true}` to user settings on install, so the global writer may replace `true` with `false`; it records the old value and undo restores it. `/ctx:global undo` removes exactly what ctx global wrote.
  - **Coming back:** in a project where a global-off plugin is needed later, `ctx on` (and `/ctx:enable`, and learned triggers) writes a local keep-on override; the user file is untouched. The SessionStart capability index lists global-off plugins that the project doesn't override.
- `ctx` keeps a registry of projects it has profiled (`~/.claude/ctx/registry.json`). `/ctx:global` also discovers every project with transcripts: the folder name is lossy, so the root comes from the transcripts' `cwd`, checked against the folder's slug. Projects whose folder no longer exists are ignored.

### 3.5 Bringing things back

See §9. In short, there are three paths: soft levels keep items callable by name; the capability index plus the `/ctx:enable` skill lets Claude re-enable an item when a task needs it; and the user can run `/ctx:on <item>` at any time.

---

## 4. Architecture

```
plugin: ctx/
  .claude-plugin/plugin.json
  skills/
    setup/SKILL.md      user-invoked   /ctx:setup    onboarding flow (§3.2)
    report/SKILL.md     user-invoked   /ctx:report   prints the current breakdown and usage
    trim/SKILL.md       user-invoked   /ctx:trim     re-plan and apply (setup without the describe step)
    on/SKILL.md         user-invoked   /ctx:on       re-enable an item
    off/SKILL.md        user-invoked   /ctx:off      disable an item
    undo/SKILL.md       user-invoked   /ctx:undo     restore the previous backup; "/ctx:undo all" restores the original
    global/SKILL.md     user-invoked   /ctx:global   cross-project baseline (§3.4)
    auto/SKILL.md       user-invoked   /ctx:auto     learned triggers on/off (§9.3)
    enable/SKILL.md     MODEL-invoked  /ctx:enable   lets Claude re-enable a disabled item (§9.2)
  hooks/hooks.json      SessionStart (fast, cached only); UserPromptSubmit (learned triggers, opt-in; silent
                        otherwise); SessionEnd (refresh the usage ledger and triggers in the background)
  dist/ctx.mjs          single bundled CLI, no runtime dependencies

state: ~/.claude/ctx/
  registry.json                     profiled projects
  config.json                       {auto, threshold} for learned triggers
  triggers.json                     learned trigger table (all projects)
  global/                           plan.json, applied.json (owned user-settings entries, replaced values,
                                    keep-on overrides per project), backups/
  measurements/<cc-version>.json    per-item costs, keyed by item id and model
  projects/<project-hash>/
    project-profile.json            description, services, work types (§5.4)
    ledger.json                     usage per item (§7.1)
    plan.json                       last proposed plan
    applied.json                    exactly which keys/values ctx wrote (ownership record)
    backups/<timestamp>.settings.local.json
```

**Data flow:** `measure` + `usage` + `project-profile` → `plan` → user confirms → `apply` → verification `measure` → `applied.json`. The `SessionStart` hook reads only `applied.json` and the cached measurement.

**Every user-invoked skill has `disable-model-invocation: true`**, so none of them appears in Claude's skill listing (S4). Only `enable` is model-invocable, and its description must stay under 200 characters.

---

## 5. Data formats

### 5.1 Item ids

| Kind | Id format | Example |
|---|---|---|
| Built-in tool | `tool:<Name>` | `tool:Artifact` |
| Plugin | `plugin:<name>@<marketplace>` | `plugin:cloudflare@cloudflare` |
| Skill | `skill:<short-name>` (plugin skills: `skill:<plugin>:<name>`, usage tracking only; they can't be overridden) | `skill:docx`, `skill:cloudflare:wrangler` |
| MCP server | `mcp:<server>` | `mcp:MCP_DOCKER`, `mcp:claude_ai_Google_Drive` |
| Memory file | `memory:<absolute path>` | `memory:C:\Users\Nev\.claude\CLAUDE.md` |

### 5.2 Measurement record

```json
{
  "ccVersion": "2.1.326",
  "model": "claude-opus-5-5",
  "measuredAt": "2026-11-18T10:00:00Z",
  "baseline": { "totalTokens": 30600, "categories": { "System prompt": 2900, "System tools": 18500, "Skills": 7300 } },
  "items": {
    "tool:Artifact": { "category": "System tools", "deltaTokens": 12000, "method": "toggle" },
    "skill:dataviz": { "category": "Skills", "deltaTokens": 480, "method": "listed" },
    "plugin:cloudflare@cloudflare": { "category": "Skills", "deltaTokens": 1300, "method": "toggle" }
  }
}
```

`method`: `listed` means the value was read directly from a `/context` table (skills, MCP tools, memory files); `toggle` means it was measured with a `--settings` run.

### 5.3 Ledger

```json
{
  "project": "c:/Users/Nev/Observibility Proxy",
  "sessionsScanned": 12,
  "window": { "sessions": 10 },
  "items": {
    "tool:Bash": { "sessionsUsed": 9, "calls": 214, "lastUsedAt": "2026-11-18T09:40:00Z" },
    "skill:watch:watch": { "sessionsUsed": 2, "calls": 2, "lastUsedAt": "2026-11-18T07:55:00Z" }
  },
  "global": { "skillUsage": {}, "pluginUsage": {} }
}
```

### 5.4 Project profile (from the describe step)

```json
{
  "summary": "Research and planning for a Claude Code context-trimming plugin",
  "stack": ["node", "typescript"],
  "services": [],
  "workTypes": ["code", "docs"],
  "keep": ["skill:watch:watch"],
  "createdAt": "2026-11-18T10:00:00Z"
}
```

`keep` holds items the user explicitly pins; they are never disabled.

---

## 6. Measurement engine (`ctx measure`)

### 6.1 Finding the `claude` binary

Try these in order and use the first that runs `--version` successfully:

1. Config `CTX_CLAUDE_BIN` (environment variable or plugin `userConfig`).
2. `claude` on PATH.
3. Platform-specific install locations:
   - **Windows:** `%USERPROFILE%\.local\bin\claude.exe`, `%APPDATA%\npm\claude.cmd`, then the newest `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe`.
   - **macOS/Linux:** `~/.local/bin/claude`, `~/.claude/local/claude`, the npm global bin directory, then the VS Code extension's `resources/native-binary/claude`.
4. **[verified M0]** Claude Code doesn't give hooks its own path. `CLAUDE_CODE_EXECPATH` is present in VS Code sessions (inherited from the extension host), so try it right after `CTX_CLAUDE_BIN`.

Record the version from `claude --version` and key every cached measurement by it.

### 6.2 Running `/context`

- Spawn `claude -p "/context"` with `cwd` = the project root and `shell: false`. Set the environment variable `MSYS_NO_PATHCONV=1` anyway.
- For toggles, spawn `claude -p --settings '<json>' "/context"`, passing the JSON as one argument.
- Timeout: 120 s per run. Run at most 3 at a time.
- Retry once on failure. After that, mark the item `unmeasured` and continue.

### 6.3 Parsing the output

The output is Markdown. Parse it defensively:

- **Total:** `**Tokens:** <n>k / <m> (<p>%)`. Convert `30.6k` to 30600 and `672` to 672.
- **Category table** under `### Estimated usage by category`: rows `| <Category> | <tokens> | <pct> |`.
- **Per-item tables:** `### MCP Tools` (`| Tool | Server | Tokens |`), `### Memory Files` (`| Type | Path | Tokens |`) and `### Skills` (`| Skill | Source | Tokens |`, where tokens may be prefixed with `~`).
- Unknown sections are kept as raw text and reported as "unparsed". Never crash on them.
- Keep the fixtures from Appendix A as tests.

### 6.4 What to toggle

- **Built-in tools:** every name found in the baseline run's upfront tool set, except the protected list (§7.3). Build the tool list as the union of names already in the measurement cache and a static seed list: Agent, Artifact, AskUserQuestion, Bash, Edit, Glob, Grep, ListAgents, PowerShell, Read, ReportFindings, ScheduleWakeup, Skill, ToolSearch, Write. **[verified M0]** `/context` doesn't list built-ins by name. Request capture does: point `ANTHROPIC_BASE_URL` at a local stub that records the request body and answers HTTP 400 (no model call). Use the non-deferred `tools[].name` from it, falling back to the seed list.
- **Plugins:** each enabled plugin, toggled with `enabledPlugins` set to false.
- **Skills:** don't toggle these; use the `listed` values. Check group savings with one combined toggle run.
- **MCP servers:** use the `listed` values. Note that deferred tools are excluded from the total.
- **Final step:** one verification run with the full proposed profile. Report this number, never the sum of the deltas.

---

## 7. Usage, classification and protection

### 7.1 Usage collection (`ctx usage`)

- **Transcripts:** scan the project's directories (case-insensitive slug match), newest first, up to `window.sessions` (default 10) sessions that each contain at least one assistant turn. Exclude ctx's own measurement sessions (§2.1).
- **Counts:** per item, record the number of sessions it was used in, the total number of calls, and when it was last used. Map tool calls to items as described in §2.5.
- **Global counters:** merge in `skillUsage` and `pluginUsage` from `~/.claude.json` as global hints. A skill with a global count of 0 and no project use is a strong "unused" signal.
- **Subagents:** count their calls too. They are stored in `<slug>/<session-id>/subagents/agent-<id>.jsonl` **[verified M0]**.

### 7.2 Classification rules (`ctx plan`)

Apply the rules in order; the first match wins. All thresholds are configurable.

| Rule | Class | Proposed action |
|---|---|---|
| On the protected list (§7.3) or in `profile.keep` | protected | none |
| Used in at least 1 of the last N sessions **in this project** | used | none |
| Matches a project signal (services or stack keywords, or a Claude review note) | likely | soft (skills `name-only`); tools stay on |
| Global usage > 0 but never used in this project | foreign | plugins: off (project-local); skills: `name-only` |
| Never used anywhere, upfront cost ≥ 200 tokens | unused | tools: deny; plugins: off; skills: `name-only` (or `off` if the user chooses "aggressive") |
| Never used anywhere, upfront cost < 200 tokens | negligible | none (listed in the report only) |

**Dependencies:** when an item goes off, its dependent skills go to `name-only` with it. v1 map:

- `tool:Artifact` → `artifact-design`, `artifact-diagramming`, `artifact-capabilities`
- `tool:ScheduleWakeup` → `loop`
- `tool:ReportFindings` ← `code-review` (**reverse**: if `code-review` is used, keep `ReportFindings`)

Keep this map as data (`deps.json`) so it can grow.

**Claude review step:** the setup skill passes Claude the draft plan, the project profile and the item descriptions. Claude may only move items toward *keeping* (more conservative), or from `none` to `soft`. It returns JSON, which the CLI validates against the rules above before showing it to the user.

### 7.3 Protected list (never disabled by ctx)

`Read`, `Edit`, `Write`, `Glob`, `Grep`, `Skill`, `ToolSearch`, `AskUserQuestion`, `EndConversation` (can't be removed anyway), the platform shell (`Bash` everywhere; `PowerShell` on Windows if it was used in this project or the user's CLAUDE.md mentions it), and the plugin's own skills. `Agent` is protected by default and can be unprotected in config.

### 7.4 MCP servers in v1

MCP tools are deferred by default, so their upfront cost is only tool names and server instructions (about 0.7K + 0.7K in the reference). v1 only reports MCP servers and suggests `/mcp` toggles for unused ones. It does not write `~/.claude.json`.

---

## 8. Settings writer (`ctx apply`, `ctx on`, `ctx off`, `ctx undo`)

### 8.1 Rules

1. **Target file:** `<project>/.claude/settings.local.json` (per user, normally git-ignored). Create `.claude/` if it's missing. If the project is a git repo and the file isn't ignored, warn and offer to add it to `.git/info/exclude`.
2. **Read and merge, never overwrite.** Parse the existing JSON. Add or remove only the specific array entries and object keys ctx owns, as recorded in `applied.json`. Never remove or change a value ctx didn't write. If the user has the same entry already, record it as `preexisting` and never remove it on undo.
3. **Back up first.** Copy the current file (or record "absent") to `backups/<ISO timestamp>.settings.local.json` before every write. Keep the last 20 backups.
4. **Write atomically.** Write `settings.local.json.tmp`, then fsync, then rename over the target. On Windows, retry the rename up to 5 times with a 100 ms backoff (file locks).
5. **Validate.** Re-read the written file and parse it. If parsing fails, restore the backup immediately and exit non-zero.
6. **Record ownership.** Update `applied.json` with each owned key path and value, plus the backup id.
7. **Undo.** `ctx undo` restores the most recent backup byte for byte. `ctx undo all` restores the earliest backup, or deletes the file if it didn't exist originally. Either way, rewrite `applied.json` to match.

### 8.2 Key mapping

| Action | JSON change |
|---|---|
| Tool off | append `"<Tool>"` to `permissions.deny` |
| Tool on | remove `"<Tool>"` from `permissions.deny` (only if ctx owns it; otherwise tell the user where the rule lives) |
| Plugin off / on | `enabledPlugins["<p>@<m>"] = false` / delete the key (if ctx owns it) |
| Skill soft / off / on | `skillOverrides["<name>"] = "name-only"` / `"off"` / delete the key |
| `.mcp.json` server off | append to `disabledMcpjsonServers` |

### 8.3 Settings in other scopes

If a deny or override the user wants reversed lives in another settings file (user, project or managed), don't edit that file in v1. Report its path and the exact key so the user can change it.

**M4 exceptions:** `/ctx:global` writes user settings, but only the entries it owns (ownership record and backups in `~/.claude/ctx/global/`). For a plugin or skill switched off in user or shared project settings, `ctx on` writes a project-local keep-on override (`enabledPlugins: true` / `skillOverrides: "on"`) instead of editing the other file. Tool denies and managed settings still can't be overridden; for those, ctx reports the path and key.

---

## 9. Bringing items back

### 9.1 Capability index (added at `SessionStart`)

When at least one item is hard-off (tool denied, plugin off, skill `off`), add `additionalContext` in this format. Keep it to one short line per item and a total under 400 tokens:

```
Switched off in this project to save context (ask or use /ctx:enable to turn one on):
- Artifact tool: publish or open web pages and docs
- cloudflare plugin: Workers, Wrangler, D1/R2/KV, Cloudflare deploys
- ScheduleWakeup tool: needed by /loop
```

Build the descriptions from the first sentence of each item's own description, truncated to 80 characters. `name-only` skills don't need entries, because they're still listed by name.

### 9.2 `/ctx:enable` (model-invocable)

- **Description (under 200 characters):** "Turn a tool, plugin or skill that ctx switched off back on, when the current task needs it. Use the item names from the 'Switched off in this project' list."
- **Behaviour:** run `ctx on <item> --reason "<task>"`. Report what changed and whether it applies now or from the next session:
  - **Tools:** callable from the next call, but invisible until `/clear` or a new session **[verified M0]**. `ctx on` therefore prints the tool's input schema (captured at measure time) so Claude can call it right away.
  - **Plugins:** applies after `/reload-plugins`. Tell the user to run it.
  - **Skills:** can be invoked by name immediately; the listing isn't refreshed **[verified M0]**.
- **Permission [verified M3]:** the model needs the allow rule `Skill(ctx:enable)` to invoke a plugin skill without a prompt. `/ctx:setup` asks the user and, if they agree, adds it as an owned entry (`apply --allow-enable` or `ctx allow-enable`). The skill's `allowed-tools: Bash(node:*)` then covers the CLI call.
- **Hot-reload delay [verified M3]:** a settings change reaches the running session after about 1 s. `ctx on` waits 1.5 s after re-enabling a tool inside Claude Code.
- **Record each re-enable** in the ledger. If an item was re-enabled within the usage window (one re-enable is enough; the original spec said twice), `ctx plan` reclassifies it as "used" so it isn't trimmed again.

### 9.3 Later milestone: learned triggers (`UserPromptSubmit`)

From the ledger, learn keywords in user prompts that preceded the use of each item (e.g. "wrangler", "deploy to workers" → `plugin:cloudflare@cloudflare`). Before Claude sees a prompt, the hook scores it locally (no model call). Above a threshold, it re-enables the item and adds a one-line note. It's off by default and switched on with `/ctx:auto on`.

**Built in M4 [verified, VERIFY.md item 28]:**

- **Learning** (`ctx triggers learn`; also run by `/ctx:auto on` and in the background at SessionEnd, at most every 6 hours): the newest 30 sessions of every project. For each typed prompt (tool results, meta lines and injected context are skipped; for slash commands only the arguments count), the items used before the next prompt are recorded. Plugins count through their skills, agents and MCP servers. Keywords per item come from two sources. **Name keywords** (weight 1) are the item's name and, for plugins, their skill folder names; only names of 4 characters or more that aren't generic words such as "loop" or "init". **Learned keywords** are words that preceded the item in at least 2 prompts with precision ≥ 0.5 (the share of all prompts containing the word that led to the item), weighted by precision × min(1, hits/3). Stored in `~/.claude/ctx/triggers.json`.
- **Scoring:** best matching keyword weight plus a quarter of each further match, capped at 1; threshold 0.75 (`--threshold`). Candidates are only items ctx switched off in this project: owned local trims (tool denies, plugins off, skills `off`) and global-off plugins without a local override. At most 2 items per prompt.
- **Hook:** `UserPromptSubmit` → `ctx hook prompt-submit`. With auto off it reads one config file and exits silently. On a match it runs `ctx on <item> --reason "auto: prompt mentions …"` and returns `additionalContext` (why, plus what `ctx on` printed: the tool schema, or the `/reload-plugins` hint) and a one-line `systemMessage` for the user.

---

## 10. Commands: behaviour and output

All commands are skills whose body tells Claude to run `node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs" <subcommand> $ARGUMENTS` and relay the output unchanged. The CLI prints plain-text tables no wider than 100 columns.

`/ctx:report` example:

```
ctx report: c:/Users/Nev/Observibility Proxy   (Claude Code 2.1.326, measured 2026-11-18)

Upfront per new session: 16.7K (was 30.6K before ctx, -45%)
  System prompt        2.6K
  Built-in tools       9.8K   Bash 5.3K · PowerShell 3.8K · Agent 1.4K · Grep 1.3K · ...
  Skills               2.4K   21 name-only
  MCP                  1.4K   3 servers, tools deferred
  Memory files         0.5K

Switched off by ctx:  tool Artifact (12.0K) · tool ScheduleWakeup (1.7K) · plugin cloudflare (1.3K)
Usage, last 10 sessions: Bash 9 · Read 10 · Edit 8 · Skill watch 2 · ...
Suggestions: none above 200 tokens.  /ctx:trim to re-plan · /ctx:undo to revert
```

Subcommands the CLI must support:

| Subcommand | Purpose | Flags |
|---|---|---|
| `measure` | Run the measurements | `--full`, `--only <id>`, `--json` |
| `usage` | Build the usage ledger | `--sessions N` |
| `plan` | Propose a profile | `--aggressive`, `--json` |
| `apply` | Write the profile | `--plan <file>`, `--yes` |
| `on <id\|name>`, `off <id\|name>` | Switch one item | |
| `undo [all]` | Restore a backup | |
| `report` | Print the breakdown | `--json` |
| `hook session-start`, `hook session-end`, `hook prompt-submit` | Hook entry points | |
| `global [plan\|apply\|undo]` | Cross-project baseline (M4) | `--days N`, `--sessions N`, `--share X`, `--min-tokens N`, `--json`; apply: `--items`, `--yes` |
| `projects` | Projects known from the registry and transcripts (M4) | |
| `auto on\|off\|status` | Learned triggers on or off (M4) | `--threshold X` |
| `triggers [learn\|test "<prompt>"]` | Show, re-learn or try the trigger table (M4) | `--json` |
| `doctor` | Diagnose setup | |

Accept fuzzy names in `on`/`off` (`artifact`, `Artifact`, `tool:Artifact`). If a name matches more than one item, list the candidates and exit.

`doctor` prints: the binary path and version, the settings files found and their scopes, the transcript directories found, the cache age, and whether the profile is in force (it compares `applied.json` with the actual file).

---

## 11. Plugin files (starting points)

`.claude-plugin/plugin.json`:

```json
{
  "name": "ctx",
  "version": "0.1.0",
  "description": "Measure what each Claude Code session loads, trim what this project doesn't use, and bring it back when needed."
}
```

`skills/setup/SKILL.md`:

```markdown
---
name: setup
description: Set up a lean context profile for this project.
disable-model-invocation: true
---
Run the ctx onboarding for this project, in order:
1. Read README and manifest files (package.json, pyproject.toml, etc.) briefly, then ask the user at most 3 questions
   with AskUserQuestion: what the project is, which external services it uses, which kinds of work they expect.
   Save the answers: node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs" profile --set '<json>'
2. node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs" measure --full
3. node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs" usage
4. node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs" plan --json  → review it against the project description; you may only
   make it MORE conservative. Write your version with: ... plan --set '<json>'
5. Show the plan grouped with savings; ask the user to confirm groups (AskUserQuestion, multiSelect).
6. node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs" apply --yes --groups '<confirmed>'
7. Relay the verified before/after numbers and tell the user to start a new session.
```

`hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear",
        "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/ctx\" hook session-start" } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/ctx\" hook session-end" } ] }
    ]
  }
}
```

**[verified M0]** The hooks.json shape above passes `claude plugin validate`. SessionStart fires in `-p` mode too. `additionalContext` reaches the request. `$ARGUMENTS`, `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SKILL_DIR}` are substituted in skill bodies (with forward slashes on Windows). Whether `allowed-tools: Bash(node:*)` avoids the permission prompt is still to be confirmed interactively.

---

## 12. Technology

- **TypeScript**, compiled with **esbuild** into a single `dist/ctx.mjs`. **No runtime dependencies**: use only Node built-ins (`fs`, `path`, `os`, `child_process`, `crypto`).
- **Runtime [M5]:** hooks and skills call `"${CLAUDE_PLUGIN_ROOT}/bin/ctx"`, a POSIX sh launcher (Claude Code runs hook commands with sh/bash, Git Bash on Windows; VERIFY.md item 32). It runs `node dist/ctx.mjs` when Node is on PATH. Otherwise it runs a standalone build: a Node single executable application, about 94–125 MB (`npm run build:bin`; the release workflow builds one per platform natively and attaches it to the GitHub release). The user puts it in `~/.claude/ctx/bin/ctx-<os>-<arch>[.exe]`. With neither, hooks exit 0 silently and SessionStart prints one hint. Skills use `allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/ctx":*)` (VERIFY.md item 33).
- **Dev dependencies:** `typescript`, `esbuild`, `vitest`, `@types/node`, `postject` (standalone builds).
- **CI:** GitHub Actions on `windows-latest`, `macos-latest` and `ubuntu-latest`: typecheck, unit tests, bundle-up-to-date check, `claude plugin validate`, standalone build, and the fresh-install e2e (fake API, no secrets). `release.yml` builds the standalone binaries on tags.
- **Paths:** Windows paths everywhere (backslashes, drive-letter case, spaces in folder names such as `Observibility Proxy`). Never build shell strings; always pass argument arrays.

---

## 13. Testing

| Layer | What | How |
|---|---|---|
| Parser | `/context` Markdown → JSON | Appendix A fixtures plus synthetic variants (missing sections, `~` values, `k` and plain numbers) |
| Transcript reader | Tool, skill, agent and MCP counts | Small JSONL fixtures; malformed lines are skipped |
| Planner | Classification rules, dependencies, protected list | Table-driven unit tests |
| Settings writer | Merge, ownership, backup, undo, atomic write, invalid JSON recovery | Temp directories; byte-for-byte undo assertions; simulated rename failure on Windows |
| Hook | Latency and output | Must finish in under 300 ms using only cached data; snapshot the `additionalContext` text |
| End to end (opt-in, `CTX_E2E=1`) | Real `claude` binary | Run measure, plan and apply on a temp project; verify that `/context` total drops; then undo and verify it's restored |

---

## 14. Milestones and acceptance

| Milestone | Scope | Acceptance |
|---|---|---|
| **M0 · Verify (1–2 days)** | Resolve every **[verify]** item in this spec, especially: does `-p "/context"` use quota; is a deny removal live mid-session; does project `true` override user `false` for `enabledPlugins`; do plugin-namespaced keys work in `skillOverrides`; transcript field paths; the hooks.json shape in plugins | A short `VERIFY.md` with the result for each item; spec sections updated where facts differ |
| **M1 · Measure + report** | Binary discovery, `/context` runner and parser, toggle measurement, cache, ledger, `/ctx:report`, `doctor` | The report on the reference machine matches §2.2 and §2.3 within ±0.2K |
| **M2 · Plan + apply + undo** | Planner, dependency map, protected list, settings writer, `/ctx:setup`, `/ctx:trim`, `/ctx:on`, `/ctx:off`, `/ctx:undo` | S1, S2 and S3 on the reference project; undo restores files byte for byte |
| **M3 · Session start + re-enable** | SessionStart hook, capability index, `/ctx:enable`, re-enable feedback into the planner | S4 and S5; a re-enabled item is not trimmed again |
| **M4 · Cross-project + triggers** | `/ctx:global`, project registry, learned `UserPromptSubmit` triggers (opt-in) | Switching between two profiled projects loads each one's extras only in that project |
| **M5 · Distribution** | Marketplace listing, standalone binaries, README with screenshots of the terminal output | Clean install on a fresh machine for each OS. **Met on Windows and Linux** (`test/e2e/fresh-install.mjs`, VERIFY.md item 36); macOS runs in CI |

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| A Claude Code update changes the `/context` format or setting names | Defensive parser, cache keyed by version, `doctor`, CI fixtures from new versions |
| A trimmed item is needed and Claude doesn't know it exists | Capability index, `/ctx:enable`, soft levels by default, never touching used items |
| The user's settings are damaged | Ownership records, merge-only writes, atomic writes, backups, validation with auto-restore |
| Measurement runs cost quota or time | M0 check; cache per version; full measurement only in setup or on request |
| Savings are smaller than users expect (cached prefixes are cheap per message) | Report real verified numbers and frame them as "tokens per new session"; no exaggerated claims |

---

## Appendix A: `/context` output fixture (reference machine, before trim, abridged)

```
## Context Usage

**Model:** claude-opus-5-5
**Tokens:** 30.6k / 1m (3%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.9k | 0.3% |
| System tools | 18.5k | 1.8% |
| MCP tools | 672 | 0.1% |
| MCP server instructions | 717 | 0.1% |
| MCP tools (deferred) | 32.6k | 3.3% |
| System tools (deferred) | 20.8k | 2.1% |
| Memory files | 490 | 0.0% |
| Skills | 7.3k | 0.7% |
| Messages | 10 | 0.0% |
| Free space | 936.4k | 93.6% |
| Autocompact buffer | 33k | 3.3% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__claude_ai_Claude_Docs__batch | claude_ai_Claude_Docs | 152 |
| mcp__MCP_DOCKER__get_me | MCP_DOCKER | 106 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| User | C:\Users\Nev\.claude\CLAUDE.md | 215 |
| AutoMem | C:\Users\Nev\.claude\projects\C--Users-Nev-Observibility-Proxy\memory\MEMORY.md | 124 |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| gepeto | User | ~30 |
| cloudflare:wrangler | Plugin (cloudflare) | ~100 |
| watch:watch | Plugin (watch) | ~120 |
| dataviz | Built-in | ~480 |
| docx | claude.ai sync | ~320 |
```

Skill costs on the reference machine, by source:

| Source | Count | Tokens |
|---|---|---|
| claude.ai sync | 13 skills | ~3.2K |
| Built-in | 16 skills | ~2.6K |
| Cloudflare plugin | 19 skills | ~1.4K |
| watch plugin | 1 skill | ~0.12K |
| User skills (gepeto, pinokio) | 2 skills | ~0.05K |

## Appendix B: the hand-made lean profile that produced 30.6K → 16.7K

`c:\Users\Nev\Observibility Proxy\.claude\settings.local.json`:

```json
{
  "permissions": { "deny": ["Artifact", "ScheduleWakeup"] },
  "enabledPlugins": { "cloudflare@cloudflare": false },
  "skillOverrides": {
    "docx": "name-only", "xlsx": "name-only", "pptx": "name-only", "pdf": "name-only",
    "google-workspace": "name-only", "built-in-browser": "name-only", "chrome-browser": "name-only",
    "computer-use": "name-only", "morning": "name-only", "import-memory": "name-only",
    "keybindings-help": "name-only", "plugin-authoring": "name-only", "schedule": "name-only",
    "loop": "name-only", "run": "name-only", "init": "name-only", "fewer-permission-prompts": "name-only",
    "simplify": "name-only", "dataviz": "name-only", "gepeto": "name-only", "pinokio": "name-only"
  }
}
```

The automated profile for this project should match or beat this result (S1). It should also put `artifact-design`, `artifact-diagramming` and `artifact-capabilities` at `name-only`, because the Artifact tool is off (dependency map, §7.2).

## Appendix C: sources

Claude Code docs, read 2026-11-18: [hooks](https://code.claude.com/docs/en/hooks), [settings](https://code.claude.com/docs/en/settings), [permissions](https://code.claude.com/docs/en/permissions), [prompt caching](https://code.claude.com/docs/en/prompt-caching), [MCP](https://code.claude.com/docs/en/mcp), [skills](https://code.claude.com/docs/en/skills), [plugins reference](https://code.claude.com/docs/en/plugins-reference), [status line](https://code.claude.com/docs/en/statusline), [monitoring usage](https://code.claude.com/docs/en/monitoring-usage).

Background reports: [Context Trimmer Plugin: Functionality-First Plan](https://claude.ai/artifact/9AFByzKrbUXAQXF9Rwh9zy) and [Observability Proxy: Research & Build Plan](https://claude.ai/artifact/X2CeQpjn12hg2TPfivNDyq).
