---
name: global
description: Cross-project baseline - switch plugins and skills used in only a few projects off in user settings, and keep them on where they're used.
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: "[undo]"
---
The CLI is `node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs"` (called CTX below). Show CLI output as printed, in code blocks.
Never edit settings files yourself; only the CLI writes them.

If the arguments say "undo" ($ARGUMENTS): run `CTX global undo`, show the output, and stop.

1. **Plan.** `CTX global` scans every project's recent sessions (no model calls) and prints which plugins and skills
   would go off (plugins) or to name-only (skills) in `~/.claude/settings.json`, and which projects keep each one on
   through a local override. Show the output.
2. If it proposes nothing, say so and stop. If a note says costs are unknown, suggest running `/ctx:setup` in a
   project first.
3. **Confirm.** This changes the user-level settings that every project inherits, so ask with AskUserQuestion
   (multiSelect, at most 4 options per question; chain questions if needed). One option per proposed item, labelled
   with its name and saving, with the projects that keep it on in the description. Don't preselect anything.
4. **Apply.** `CTX global apply --yes --items <comma-separated confirmed ids>` (ids exactly as printed, e.g.
   `plugin:cloudflare@cloudflare,skill:docx`). Show the output.
5. **Hand off.** Tell the user: new sessions in every project use the baseline; a project that needs an item later
   gets it back with `/ctx:on <item>` (a local override for that project only); `/ctx:global undo` reverts it all.
   If plugins changed, `/reload-plugins` applies them to this session.
