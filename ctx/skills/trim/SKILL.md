---
name: trim
description: Re-measure and re-plan this project's lean profile, then apply the groups the user confirms.
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: "[aggressive]"
---
Re-run the ctx plan for this project. The CLI is `node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs"` (called CTX below).
Run every command from the project root and show its output as printed, in code blocks. Never edit settings
files yourself.

1. `CTX measure` (reuses the cached measurement if settings haven't changed) and `CTX usage`.
2. `CTX plan --json` (add `--aggressive` if the arguments say "aggressive": $ARGUMENTS). If `CTX profile` shows
   a project description, review the draft against it. You may only make it more conservative, or move an unused
   skill from "none" to "soft": `CTX plan --set '{"items":[{"id":"...","action":"none","reason":"..."}]}'`.
   Then run `CTX plan` and show it.
3. Ask the user which groups to apply (AskUserQuestion, multiSelect, at most 4 options per question, labelled
   with each group's estimated saving). Don't preselect or recommend "rare"; skip "mcp" (advice only).
4. `CTX apply --yes --groups <confirmed groups>`. Items ctx switched off earlier that the new plan no longer
   lists are switched back on automatically. Relay the verified numbers, and say that new sessions use the
   result.
