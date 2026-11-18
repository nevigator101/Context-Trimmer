// M3 end to end (spec §9): SessionStart hook -> capability index -> model invokes /ctx:enable -> ctx on runs
// without a permission prompt -> the deny is gone and the tool schema is printed.
// Real claude binary + fake API (no quota). Run: node test/e2e/enable-loop.mjs   (about 1 minute)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, startFakeApi } from './fake-api.mjs';
import { session } from './live-reload.mjs';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ctx');
const cli = path.join(pluginDir, 'dist', 'ctx.mjs');
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx enable '));
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-enable-state-'));
process.env.CTX_HOME = state; // inherited by claude and its hooks
const ctx = (...args) => spawnSync(process.execPath, [cli, ...args, '--project', proj], { encoding: 'utf8', env: process.env });

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failed++; };

const m = ctx('measure', '--full');
check('measure', m.status === 0, (m.stdout.split('\n')[0] ?? '') + m.stderr.slice(-200));
const off = ctx('off', 'Artifact');
check('ctx off Artifact', off.status === 0, off.stdout.split('\n')[0]);
const allow = ctx('allow-enable');
check('ctx allow-enable', allow.status === 0, allow.stdout.split('\n')[0]);

const api = await startFakeApi();
const s = await session(proj, { api, extraArgs: ['--plugin-dir', pluginDir] });
try {
  // 1. The hook's index reaches the first request.
  const t1 = await s.turn('hello');
  const first = t1.requests[0];
  check('index in request', first.has('Switched off in this project to save context') && first.has('- Artifact tool:'));
  check('Artifact not in tool list', !first.tools.includes('Artifact'));
  check('enable skill listed for the model', first.has('ctx:enable'));
  const startMsg = s.events.find((e) => JSON.stringify(e).includes('lean profile active'));
  check('status line emitted', !!startMsg);

  // 2. The model invokes /ctx:enable; 3. it runs the command the skill names.
  // The command exactly as the enable skill names it: the launcher, which its allowed-tools rule covers.
  const cmd = `"${pluginDir.replace(/\\/g, '/')}/bin/ctx" on Artifact --reason "publish a page"`;
  api.script.push((body) => {
    const last = inspect(body).toolResults.at(-1);
    return last && /ctx:enable|Launching skill/.test(last.content) ? { tool: 'Bash', input: { command: cmd, description: 'Re-enable Artifact' } } : undefined;
  });
  const t2 = await s.turn('CALL Skill {"skill":"ctx:enable","args":"Artifact"}');
  const results = t2.requests.flatMap((r) => r.toolResults);
  const skillRes = results.find((r) => /Launching skill/.test(r.content));
  check('model can invoke ctx:enable', !!skillRes && !skillRes.is_error, skillRes?.content.slice(0, 80));
  const onRes = t2.requests.at(-1).toolResults.at(-1);
  check('ctx on ran without approval', !!onRes && !onRes.is_error && /on again/.test(onRes.content), onRes?.content.slice(0, 120));
  check('schema printed', /input schema/.test(onRes?.content ?? ''));

  // 4. Settings and ledger.
  const local = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8'));
  check('deny removed', !(local.permissions?.deny ?? []).includes('Artifact'), JSON.stringify(local));
  const ledgerFile = fs.readdirSync(path.join(state, 'projects')).map((d) => path.join(state, 'projects', d, 'ledger.json')).find((f) => fs.existsSync(f));
  const ledger = ledgerFile ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {};
  check('re-enable recorded', (ledger.reenables?.['tool:Artifact'] ?? []).length === 1);

  // 5. The tool is callable in the same session (settings hot-reload is not instant; give it a moment).
  await new Promise((r) => setTimeout(r, Number(process.env.RELOAD_WAIT_MS ?? 3000)));
  // Deliberately invalid input: an input-validation error proves the tool is available without running it.
  const t3 = await s.turn('CALL Artifact {"__ctx_probe__":true}');
  const art = t3.requests.at(-1).toolResults.at(-1);
  check('Artifact callable now', !!art && !/No such tool available|disabled for this session/.test(art.content), art?.content.slice(0, 100));
} catch (e) {
  check('session', false, String(e.message ?? e));
} finally {
  await s.close();
  api.close();
}
try { fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); } catch { /* Windows */ }
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
