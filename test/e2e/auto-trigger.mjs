// M4 learned triggers end to end (spec §9.3): UserPromptSubmit hook receives the prompt, matches it against the
// project's switched-off items, switches the item back on and its note reaches the request.
// Real claude binary + fake API (no quota). Trigger learning reads this machine's transcripts (read only).
// Run: node test/e2e/auto-trigger.mjs   (about 1 minute)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi } from './fake-api.mjs';
import { session } from './live-reload.mjs';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ctx');
const cli = path.join(pluginDir, 'dist', 'ctx.mjs');
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx auto '));
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-auto-state-'));
process.env.CTX_HOME = state; // inherited by claude and its hooks
const ctx = (...args) => spawnSync(process.execPath, [cli, ...args, '--project', proj], { encoding: 'utf8', env: process.env });
const localFile = path.join(proj, '.claude', 'settings.local.json');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failed++; };

const m = ctx('measure', '--only', 'plugin:cloudflare@cloudflare');
check('measure', m.status === 0, m.stderr.slice(-200));
const off = ctx('off', 'cloudflare');
check('ctx off cloudflare', off.status === 0, off.stdout.split('\n')[0]);
const auto = ctx('auto', 'on');
check('ctx auto on (learns triggers)', auto.status === 0, auto.stdout.split('\n')[0]);
const status = ctx('auto');
check('status lists the switched-off item', /plugin:cloudflare@cloudflare\s+cloudflare/.test(status.stdout), status.stdout.split('\n').at(-2));
const probe = ctx('triggers', 'test', 'deploy this worker with wrangler');
check('trigger test matches', /^ON\s+plugin:cloudflare@cloudflare .*wrangler/m.test(probe.stdout), probe.stdout.split('\n')[0]);

const api = await startFakeApi();
const s = await session(proj, { api, extraArgs: ['--plugin-dir', pluginDir] });
try {
  const t0 = performance.now();
  const t1 = await s.turn('refactor the parser module');
  check('unrelated prompt: nothing switched on', !t1.requests[0].has('ctx switched') && JSON.parse(fs.readFileSync(localFile, 'utf8')).enabledPlugins?.['cloudflare@cloudflare'] === false);
  console.log(`      (first turn incl. startup: ${Math.round(performance.now() - t0)} ms)`);

  const t2 = await s.turn('deploy this worker with wrangler');
  // The turn may also send a session-title request; the note must be in the conversation request.
  const NOTE = 'ctx switched plugin:cloudflare@cloudflare back on because the prompt mentions';
  const req = t2.requests.find((r) => r.has(NOTE)) ?? t2.requests.at(-1);
  check('note reaches the request', req.has(NOTE), (req.messagesJson.match(/ctx switched plugin[^"\\]{0,80}/) ?? [''])[0]);
  check('reload hint for Claude', req.has('/reload-plugins'));
  // The off entry was the file's only content and ctx created the file, so switching it on removes the file.
  const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : {};
  check('cloudflare back on in settings', local.enabledPlugins?.['cloudflare@cloudflare'] === undefined, JSON.stringify(local));
  const msg = s.events.find((e) => JSON.stringify(e).includes('ctx: switched on cloudflare'));
  check('user notice emitted', !!msg);
} catch (e) {
  check('session', false, String(e.message ?? e));
} finally {
  await s.close();
  api.close();
}
try { fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); } catch { /* Windows */ }
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
