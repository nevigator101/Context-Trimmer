---
name: report
description: Show what this project loads into every new session, what is switched off, and what is unused.
disable-model-invocation: true
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/ctx":*)
---
Run this command from the project root and show its output to the user exactly as printed, in a code block:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ctx" report $ARGUMENTS
```

If it fails, run `"${CLAUDE_PLUGIN_ROOT}/bin/ctx" doctor` and show that output instead.
Do not change any settings files.
