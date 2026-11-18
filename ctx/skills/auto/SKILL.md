---
name: auto
description: Turn learned triggers on or off - ctx switches a trimmed item back on when a prompt clearly needs it.
disable-model-invocation: true
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/ctx":*)
argument-hint: "on|off|status"
---
Run from the project root and show the output as printed, in a code block:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ctx" auto $ARGUMENTS
```

With no argument it prints the status: whether auto re-enable is on, and for each item switched off in this project
the prompt words that would switch it back on. `on` learns the trigger words from recent sessions in all projects
(local only, no model calls). After that, when a prompt mentions one of them, ctx switches that item on before
Claude reads the prompt and prints a one-line notice. `off` stops this.
