#!/bin/sh
# Linux run of the unit tests, the standalone build and the fresh-install e2e, in a throwaway container.
# From the repo root (Git Bash: prefix with MSYS_NO_PATHCONV=1 and use "$(pwd -W)"):
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/release:/out" node:22-bookworm sh /src/test/e2e/docker-linux.sh
# Installs Claude Code from npm inside the container (native binary; no login: the e2e uses a fake API).
set -e
mkdir -p /work
tar -C /src --exclude=./node_modules --exclude=./release -cf - . | tar -C /work -xf -
cd /work
npm ci --no-audit --no-fund >/dev/null
npm i -g @anthropic-ai/claude-code >/dev/null 2>&1
CLAUDE_BIN=$(readlink -f "$(command -v claude)")
echo "claude: $CLAUDE_BIN ($("$CLAUDE_BIN" --version))"
npx tsc --noEmit
npx vitest run 2>&1 | tail -4
node build.mjs >/dev/null 2>&1
cmp -s ctx/dist/ctx.mjs /src/ctx/dist/ctx.mjs && echo "bundle: identical to the committed one" || echo "bundle: DIFFERS from the committed one"
node scripts/build-sea.mjs
if [ -d /out ]; then cp release/ctx-linux-* /out/; fi
CTX_CLAUDE_BIN="$CLAUDE_BIN" node test/e2e/fresh-install.mjs
