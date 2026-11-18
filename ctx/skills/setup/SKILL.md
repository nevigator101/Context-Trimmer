---
name: setup
description: Set up a lean context profile for this project - describe, measure, plan, confirm, apply.
disable-model-invocation: true
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/ctx":*), Read, Glob
argument-hint: "[aggressive]"
---
Run the ctx onboarding for this project. The CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/ctx"` (called CTX below).
Run every command from the project root. Show CLI output to the user as printed, in code blocks. Never edit settings
files yourself; only the CLI writes them.

1. **Describe.** Read the README and the manifest files (package.json, pyproject.toml, Cargo.toml, go.mod, etc.)
   briefly, and list the top-level folders. Then ask the user at most 3 questions in one AskUserQuestion call:
   what the project is (offer your own one-line guess as the first option), which external services it uses,
   and which kinds of work they expect (multiSelect: code, docs, media, deploys, research, data).
   Save the answers:
   `CTX profile --set '{"summary":"...","stack":[...],"services":[...],"workTypes":[...]}'`
2. **Measure.** `CTX measure --full` (about 30 seconds; no model calls, no quota).
3. **Usage.** `CTX usage`
4. **Plan.** `CTX plan --json` (add `--aggressive` if the arguments say "aggressive": $ARGUMENTS).
   Review the draft against the project description. You may only make it MORE conservative (for example, keep a
   tool the project clearly needs) or move an unused skill from "none" to "soft". Write your changes, if any:
   `CTX plan --set '{"items":[{"id":"tool:Artifact","action":"none","reason":"the project publishes docs"}]}'`
   Then run `CTX plan` and show its output.
5. **Confirm.** Ask with AskUserQuestion (multiSelect, at most 4 options per question; use a second question for
   any remaining groups). One option per group in the plan output, labelled with the group name and its estimated
   saving. Put "tools", "plugins" and "skills" first. The "rare" group lists items the user did use recently:
   describe it that way and don't preselect or recommend it. Skip the "mcp" group: it is advice only.
   In the same AskUserQuestion call, ask whether Claude may switch a trimmed item back on by itself when a task
   needs it (options: "Yes, without asking" - adds the allow rule Skill(ctx:enable); "Ask me each time").
6. **Apply.** `CTX apply --yes --groups <comma-separated confirmed groups>`, adding `--allow-enable` if the user
   chose "Yes, without asking".
   If it warns that settings.local.json isn't git-ignored, ask the user, and if they agree re-run with
   `--git-exclude`.
7. **Hand off.** Relay the verified before/after numbers from the apply output. Tell the user: new sessions
   (`/clear` or a new chat) use the lean setup; `/ctx:on <item>` brings anything back; `/ctx:undo` reverts.
   If the plan listed MCP servers, mention they can be switched off with `/mcp`.
