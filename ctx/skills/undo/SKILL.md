---
name: undo
description: Undo ctx's last settings change in this project; "/ctx:undo all" restores the original file.
disable-model-invocation: true
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/ctx":*)
argument-hint: "[all]"
---
Run from the project root and show the output as printed, in a code block:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ctx" undo $ARGUMENTS
```

Tell the user that new sessions use the restored settings.
