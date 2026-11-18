import { build } from 'esbuild';
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'ctx/dist/ctx.mjs',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
