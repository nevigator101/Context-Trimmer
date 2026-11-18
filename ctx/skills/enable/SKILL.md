---
name: enable
description: Turn a tool, plugin or skill that ctx switched off back on, when the current task needs it. Use the item names from the 'Switched off in this project' list.
allowed-tools: Bash(node:*)
argument-hint: "<item>"
---
Switch the item back on. Run from the project root, filling in the item if it isn't given here ("$ARGUMENTS") and
a one-line description of the task that needs it:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/ctx.mjs" on <item> --reason "<task>"
```

Then follow what the output says, and tell the user in one line what you switched on and why:
- **Tool:** it can be called now. If the output printed an input schema, call the tool with arguments matching it.
  It appears in the tool list after `/clear` or in a new session.
- **Plugin:** ask the user to run `/reload-plugins`, then continue.
- **Skill:** invoke it by name now.
- If the output lists several matches, pick the one that fits the task and run the command again with its exact id.
- If it says the entry wasn't set by ctx or lives in another settings file, don't force it: tell the user where
  it is and let them decide.
