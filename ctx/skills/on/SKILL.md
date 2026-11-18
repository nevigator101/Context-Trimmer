---
name: on
description: Switch a tool, plugin or skill back on in this project, e.g. /ctx:on artifact.
disable-model-invocation: true
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/ctx":*)
argument-hint: "<item>"
---
Run from the project root and show the output as printed, in a code block:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ctx" on $ARGUMENTS
```

- If it lists several matching items, ask the user which one they mean, then run it again with the exact id.
- If it says the entry wasn't written by ctx, explain that, and add `--force` only if the user agrees.
- If it says the entry lives in another settings file, tell the user the path and key; don't edit that file.
- If it prints a tool's input schema, the tool can be called in this session right away using that schema.
