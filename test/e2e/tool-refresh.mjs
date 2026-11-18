// VERIFY.md items 9 and 17. Run: node test/e2e/tool-refresh.mjs
// (a) After a deny is removed mid-session, do /clear or /compact bring the tool back into the tool list?
// (b) Does a plugin skill's `allowed-tools: Bash(node:*)` let the skill run node without a permission prompt?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi } from './fake-api.mjs';
import { session } from './live-reload.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ctx');

async function refresh(cmd) {
  const api = await startFakeApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-refresh-'));
  const local = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, JSON.stringify({ permissions: { deny: ['Glob'] } }));
  const s = await session(dir, { api });
  const out = { cmd };
  try {
    const t1 = await s.turn('hello');
    out.before = t1.requests[0].tools.includes('Glob');
    fs.writeFileSync(local, '{}\n');
    await sleep(3000);
    const t2 = await s.turn('hello');
    out.afterEdit = t2.requests[0].tools.includes('Glob');
    await s.turn(cmd);
    const t3 = await s.turn('hello');
    out.afterCmd = t3.requests[0].tools.includes('Glob');
  } catch (e) {
    out.error = String(e.message ?? e);
  } finally {
    await s.close();
    api.close();
  }
  return out;
}

async function allowedTools() {
  const api = await startFakeApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-allowed-'));
  const s = await session(dir, { api, extraArgs: ['--plugin-dir', pluginDir] });
  const out = {};
  try {
    // The fake API answers the skill turn with the Bash call the skill body names.
    const t = await s.turn('/ctx:doctor');
    out.skillTurn = t.requests.at(-1)?.toolResults.at(-1);
    // Same command outside a skill turn, for comparison.
    const cmd = `node "${pluginDir.replace(/\\/g, '/')}/dist/ctx.mjs" help`;
    const t2 = await s.turn(`CALL Bash ${JSON.stringify({ command: cmd, description: 'ctx help' })}`);
    out.plainTurn = t2.requests.at(-1)?.toolResults.at(-1);
  } catch (e) {
    out.error = String(e.message ?? e);
  } finally {
    await s.close();
    api.close();
  }
  return out;
}

const results = [];
for (const cmd of ['/clear', '/compact']) results.push(await refresh(cmd));
results.push({ allowedTools: await allowedTools() });
console.log(JSON.stringify(results, null, 2));
