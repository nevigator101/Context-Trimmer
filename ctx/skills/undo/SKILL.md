---
name: undo
description: Undo ctx's last settings change in this project; "/ctx:undo all" restores the original file.
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: "[all]"
---
Run from the project root and show the output as printed, in a code block:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs" undo $ARGUMENTS
```

Tell the user that new sessions use the restored settings.
