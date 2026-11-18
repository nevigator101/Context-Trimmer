---
name: doctor
description: Diagnose the ctx setup for this project (binary, settings files, transcripts, cache).
disable-model-invocation: true
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/ctx":*)
---
Run this command from the project root and show its output to the user exactly as printed, in a code block:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ctx" doctor
```
