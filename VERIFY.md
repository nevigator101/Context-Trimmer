# ctx: Milestone 0 verification results

**Run:** 2026-11-18 · Windows 11 · Claude Code 2.1.326 (VS Code-bundled `claude.exe`) · model `claude-opus-5-5`

Method: headless `claude -p --output-format json --no-session-persistence [--setting-sources …] [--settings <json>] "/context"`
runs in this project and in scratch projects, plus **request capture**: `ANTHROPIC_BASE_URL` pointed at a local stub
server that saves the request body and answers HTTP 400, so no model call is made and no quota is used.

## Results

| # | Spec item | Result | Spec impact |
|---|---|---|---|
| 1 | Does `-p "/context"` make a model call or use quota? (§2.1) | **No.** `total_cost_usd: 0`, `num_turns: 0`, `duration_api_ms: 0`; about 4 s per run. | Measurement is free; it can run more often than planned. |
| 2 | Do `-p` runs create transcripts? (§2.1) | **Yes**, without the flag: 20+ sessions with only `/context` as the user message and no assistant turn were found in this project's transcript directory. **`--no-session-persistence` exists and prevents it.** | Always pass `--no-session-persistence`. The ledger also skips sessions with no assistant turn. |
| 3 | stdin | `-p` waits 3 s for stdin and prints a warning to stdout, which breaks JSON parsing. | Spawn with `stdio: ['ignore','pipe','pipe']`. |
| 4 | Measuring the untrimmed state | `--setting-sources user,project` (local file excluded) reproduces **30.6K** exactly. | The reference run is `--setting-sources user,project --settings <local file minus trim keys>`. |
| 5 | Tool deny via `--settings` | Works, and the total moves correctly: denying Artifact gives 30.6K → 18.4K (System tools 18.5K → 6.5K, System prompt 2.9K → 2.6K). | As specified. |
| 6 | **Skill overrides and plugin-off in `/context`** | **The headline total doesn't change.** The Skills row drops and the System tools row rises by the same amount (examples: three overrides: Skills 7.3K → 6.1K, System tools 18.5K → 19.7K, total 30.6K; cloudflare off: Skills 7.3K → 6.0K, System tools 18.5K → 19.8K, total 30.6K). Request capture shows **the real request does shrink** (5 overrides: −5.4K chars; cloudflare off: −4.2K chars). | **New fact.** `/context`'s total misses skill and plugin savings. The engine reports `corrected = total − (Skills_reference − Skills_run)`. The reference profile's real lean total is about **11.8K**, not 16.7K; the whole 13.9K drop shown in §2.2 came from the two tool denies. |
| 7 | Plugin-namespaced keys in `skillOverrides` (§2.4) | **Don't work.** Tried `cloudflare:wrangler`, `wrangler` and `cloudflare@cloudflare:wrangler`, in both `--settings` and a real `settings.local.json`: the skill stays listed in `/context` **and** in the captured request. Short names for built-in and claude.ai-synced skills work (`dataviz`, `docs`). | Plugin skills can only be trimmed by switching their whole plugin off. Remove `skill:<plugin>:<name>` overrides from the planner. |
| 8 | Project `true` overrides user `false` in `enabledPlugins` (§2.4, §3.4) | **Yes.** Tested with a temporary `CLAUDE_CONFIG_DIR` where the user level had `watch@claude-video: false`: `watch:watch` is absent from the scratch project and present when that project's `.claude/settings.json` sets it to `true`. | `/ctx:global` (M4) is viable. |
| 9 | Deny **removal** live mid-session (§2.4, §9.2) | **Partly.** Re-checked with the fake API (`test/e2e/live-reload.mjs`, `tool-refresh.mjs`). After the deny is removed, a call to the tool **runs** (Glob returned files). But the tool is **not added back** to the request's tool list, and `ToolSearch select:Glob` answers "No matching deferred tools found", so the model can't see its schema. **`/clear` rebuilds the tool list (Glob is back); `/compact` doesn't.** | `/ctx:enable` for tools prints the tool's input schema (saved at measure time) so Claude can call it right away, and says `/clear` or a new session makes it fully visible. |
| 10 | Skills hot-reload mid-session (§9.2) | **Yes, for invocation.** After `skillOverrides.dataviz: "off"` is removed, `Skill {skill:"dataviz"}` returns "Launching skill: dataviz" on the next turn. The skill **listing** in later requests isn't refreshed. | `/ctx:enable` for skills: works at once; tell Claude to invoke it by name. |
| 11 | Transcript field paths (§2.5) | Confirmed: `type:"assistant"` → `message.content[]` → `{type:"tool_use", name, input}`; `input.skill` for Skill; `input.subagent_type` for Agent; typed commands as `<command-name>/x</command-name>` in `type:"user"` string content; `timestamp` on each line; `cwd`, `version`, `entrypoint` on most lines. There are many other line types (`api-request`, `attachment`, `tools-used`, `cost-state` and more). | Skill names in `input.skill` can be **qualified**: claude.ai-synced skills appear as `anthropic-skills:docs`, while `/context` and `skillOverrides` use `docs`. Strip the `anthropic-skills:` prefix. |
| 12 | Subagent transcripts (§7.1) | `~/.claude/projects/<slug>/<session-id>/subagents/agent-<id>.jsonl` (plus `.meta.json`); lines have `isSidechain: true`. | Count them as part of their parent session. |
| 13 | Project slug | Every non-alphanumeric character becomes `-`. Drive-letter case varies (`C--Users-…` from hooks and `-p`, `c--Users-…` from VS Code). | Match case-insensitively, as specified. |
| 14 | Binary path in hooks (§6.1 step 4) | `CLAUDE_CODE_EXECPATH` is set in VS Code sessions, but it's **inherited** from the extension host: Claude Code doesn't set it for hooks. | Use it when present (after `CTX_CLAUDE_BIN`), then fall back to discovery. |
| 15 | hooks.json shape in plugins (§11) | The §11 shape passes `claude plugin validate`. SessionStart fires in `-p` mode. The hook receives `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR` and `CLAUDE_ENV_FILE`, plus stdin JSON with `session_id`, `transcript_path`, `cwd`, `source`. **`hookSpecificOutput.additionalContext` reaches the request** as a system message: `SessionStart hook additional context: …`. | As specified. |
| 16 | `$ARGUMENTS` in plugin skills (§11) | Works: `/ctxprobe:probe alpha beta` expanded to `Args were: alpha beta`. | As specified. |
| 17 | `allowed-tools` needed to run `node` without a prompt? | **Yes, it works.** In a `-p` session with `--plugin-dir ./ctx`, `/ctx:doctor` ran `node …/ctx.mjs doctor` without approval; the same kind of command outside the skill turn got "This command requires approval". | Every ctx skill declares `allowed-tools: Bash(node:*)`. |
| 18 | `/context` lists upfront built-ins by name? (§6.4) | **No**, only categories. Request capture lists them exactly (15 tools here: Agent, Artifact, Bash, Edit, Glob, Grep, ListAgents, PowerShell, Read, ReportFindings, ScheduleWakeup, Skill, ToolSearch, Write, plus a `DeferredToolPlaceholder`). | The engine discovers the tool list by request capture and falls back to the seed list. |
| 19 | `/context` format changes vs Appendix A | Small skills now show as `< 20` instead of `~n`. | The parser accepts `< n`, `~n`, `n`, `n.nk` and `n.nm`. |
| 20 | `~/.claude.json` counters | `skillUsage[name] = {usageCount, lastUsedAt(epoch ms)}`; `pluginUsage[id] = {usageCount, lastUsedAt, lastUsedNumStartups}`; project entries keyed `c:/Users/Nev/Observibility Proxy` (forward slashes, lower-case drive). | As specified; read only. |
| 21 | `/reload-plugins` mid-session | **Yes.** It prints "Reloaded: 2 plugins · 20 skills · …". The re-enabled plugin's skills appear in the next request's listing and can be invoked (subject to the normal Skill permission). | `/ctx:enable` for plugins: tell the user to run `/reload-plugins`. |

## Milestone 3 findings (2026-11-18, `test/e2e/enable-loop.mjs`)

| # | Question | Result | Design impact |
|---|---|---|---|
| 22 | Can the model invoke `/ctx:enable` without a prompt? | **No, not by default.** A model-invoked *plugin* skill needs permission: in `-p` mode it was refused with "The user can add the allow rule Skill(ctx:enable)". With that rule in `permissions.allow`, the skill launches, and its `allowed-tools: Bash(node:*)` covers the `node … on` call. | `ctx allow-enable` and `apply --allow-enable` add `Skill(ctx:enable)` as an owned, undoable entry. `/ctx:setup` asks the user first. |
| 23 | How fast does a settings change reach a running session? | A tool call made right after the deny was removed still failed ("disabled for this session"); after 1 s it worked. ctx's atomic replace (temp file and rename) is picked up by the watcher. | When `ctx on` re-enables a tool inside Claude Code, it waits 1.5 s before returning. |
| 24 | S4: the plugin's own context cost | Request capture with and without `--plugin-dir ./ctx`: **+172 chars (about 50 tokens)**, which is only the `ctx:enable` listing line. The seven user-only skills aren't listed. The capability index for this project adds about 100 tokens. | Meets S4 (under 300 with nothing off, under 600 with the index). |
| 25 | S5: SessionStart hook latency | About 160 ms per run (Node startup included) on the reference machine; unit test `S5` checks under 300 ms. | Meets S5. |

## Changes to the design (applied in code)

1. Every measurement run passes `--no-session-persistence` and spawns with stdin ignored.
2. Reported totals are **corrected** for the skill-row quirk (item 6). The report shows both the raw `/context` number and the corrected one.
3. Plugin skills are never set in `skillOverrides`; their plugin is the lever.
4. The upfront tool list comes from request capture when it works; otherwise from the seed list.
5. The measurement cache is stored **per project** (`projects/<hash>/measurement.json`), keyed by Claude Code version plus a fingerprint of the settings files, because costs depend on the project's skills, memory files and MCP config.

## Still open

Nothing. Items 9, 10, 17 and 21 were rechecked on 2026-11-18 with a fake Anthropic API (`test/e2e/fake-api.mjs`): a local server that returns scripted `tool_use` replies and drives a multi-turn `-p --input-format stream-json` session in a scratch project, with settings edited between turns. None of the earlier gaps came from the build being early; they needed a way to drive a live session.
