---
name: off
description: Switch a tool, plugin or skill off in this project, e.g. /ctx:off cloudflare.
disable-model-invocation: true
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/ctx":*)
argument-hint: "<item> [--level off]"
---
Run from the project root and show the output as printed, in a code block:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ctx" off $ARGUMENTS
```

Skills go to name-only by default (still callable by name); `--level off` hides them completely.
- If it lists several matching items, ask the user which one they mean, then run it again with the exact id.
- If it refuses because the item is protected, explain why, and add `--force` only if the user insists.
