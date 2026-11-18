// Standalone ctx for machines without Node.js: a Node single executable application (SEA) for the current platform.
// Output: release/ctx-<os>-<arch>[.exe] (about 90 MB; not committed; CI attaches one per platform to a release).
// Users put it in ~/.claude/ctx/bin/, where the bin/ctx launcher finds it when `node` isn't on PATH.
// Run: node scripts/build-sea.mjs   (Node 20.12+; macOS needs the Xcode command line tools for codesign)
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repo, 'release');
fs.mkdirSync(out, { recursive: true });

const os = process.platform === 'win32' ? 'windows' : process.platform;
const ext = process.platform === 'win32' ? '.exe' : '';
const name = `ctx-${os}-${process.arch}${ext}`;
const target = path.join(out, name);
const main = path.join(out, 'ctx-sea.cjs');
const blob = path.join(out, 'ctx-sea.blob');

// SEA entry points must be CommonJS.
await build({
  entryPoints: [path.join(repo, 'src', 'cli.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  outfile: main, logLevel: 'warning',
});
const config = path.join(out, 'sea-config.json');
fs.writeFileSync(config, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

fs.copyFileSync(process.execPath, target);
fs.chmodSync(target, 0o755);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', target], { stdio: 'inherit' });
const postject = path.join(repo, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(process.execPath, [postject, target, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])], { stdio: 'inherit' });
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', target], { stdio: 'inherit' });

for (const f of [main, blob, config]) fs.rmSync(f, { force: true });
// Smoke test: the binary runs and is the standalone build.
const v = execFileSync(target, ['help'], { encoding: 'utf8' });
if (!v.startsWith('ctx:')) throw new Error(`built binary did not run: ${v.slice(0, 200)}`);
console.log(`${path.relative(repo, target)}  ${(fs.statSync(target).size / 1e6).toFixed(0)} MB`);
