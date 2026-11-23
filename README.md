# Context-Trimmer (ctx): development workspace

This repository is a Claude Code plugin marketplace with one plugin, **ctx**, in [`ctx/`](ctx/). For what it does and how to install it, see [`ctx/README.md`](ctx/README.md).

| Path | Contents |
|---|---|
| `.claude-plugin/marketplace.json` | The marketplace that lists `ctx` |
| `ctx/` | The shipped plugin: skills, hooks, the `bin/ctx` launcher and the bundled CLI `dist/ctx.mjs` (committed) |
| `src/` | TypeScript sources of the CLI |
| `test/` | Unit tests (vitest) and `test/e2e/` end-to-end scripts |
| `scripts/` | `validate.mjs` (`claude plugin validate`), `build-sea.mjs` (standalone build) |
| `IMPLEMENTATION_SPEC.md`, `VERIFY.md` | The design and the verified facts it rests on |

## Build and test

```
npm ci
npm run typecheck
npm test                 # unit tests
npm run build            # bundles src/ into ctx/dist/ctx.mjs; commit the result
npm run validate         # claude plugin validate ./ctx
npm run build:bin        # standalone build for this platform in release/ (not committed)
```

End-to-end scripts (`node test/e2e/<name>.mjs`) use the real `claude` binary (`CTX_CLAUDE_BIN`, or the one on PATH). They need no model calls and no quota: they use `/context`, which makes no request, or a fake Anthropic API (`fake-api.mjs`). None of them change your own Claude Code config; they work in temporary config dirs, state dirs and scratch projects.

| Script | Checks |
|---|---|
| `fresh-install.mjs` | Marketplace add and install in a fresh config, hooks, skills without prompts, no-Node and standalone runs, uninstall |
| `apply-cycle.mjs` | Measure, plan, apply, verify, off/on, undo (byte for byte) |
| `enable-loop.mjs` | SessionStart capability index, model-invoked `/ctx:enable` |
| `global-switch.mjs` | `/ctx:global`: two projects each load only their own extra; undo |
| `auto-trigger.mjs` | Learned triggers through the UserPromptSubmit hook |
| `live-reload.mjs`, `tool-refresh.mjs` | Mid-session settings reload behaviour |
| `demo.mjs` | Regenerates the terminal samples in `ctx/README.md` |
| `docker-linux.sh` | Unit tests, standalone build and `fresh-install.mjs` on Linux in Docker (usage in the file) |

CI (`.github/workflows/ci.yml`) runs the unit tests, validation, the standalone build and `fresh-install.mjs` on Windows, macOS and Linux. Pushing a `v*` tag runs `release.yml`, which builds the standalone binaries for six platforms and attaches them to the GitHub release.
