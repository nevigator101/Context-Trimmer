---
name: report
description: Show what this project loads into every new session, what is switched off, and what is unused.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
Run this command from the project root and show its output to the user exactly as printed, in a code block:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs" report $ARGUMENTS
```

If it fails, run `node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs" doctor` and show that output instead.
Do not change any settings files.
