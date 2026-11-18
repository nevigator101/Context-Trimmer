// Live-reload experiment (VERIFY.md items 9, 10, 21). Run: node test/e2e/live-reload.mjs
// Starts a headless multi-turn session in a scratch project against the fake API, then changes that
// project's settings.local.json between turns and checks what the next request contains.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { inspect, startFakeApi } from './fake-api.mjs';

const bin = process.env.CTX_CLAUDE_BIN ?? process.env.CLAUDE_CODE_EXECPATH ?? 'claude';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function session(cwd, { api, extraArgs = [] }) {
  const p = spawn(bin, ['-p', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', ...extraArgs], {
    cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ANTHROPIC_BASE_URL: api.url, MSYS_NO_PATHCONV: '1' },
  });
  const events = [];
  let waiter = null;
  readline.createInterface({ input: p.stdout }).on('line', (l) => {
    try {
      const e = JSON.parse(l);
      events.push(e);
      if (e.type === 'result' && waiter) { const w = waiter; waiter = null; w(e); }
    } catch { /* ignore */ }
  });
  let stderr = '';
  p.stderr.on('data', (d) => { stderr += d; });
  return {
    events,
    get stderr() { return stderr; },
    async turn(text, timeoutMs = 60_000) {
      const before = api.requests.length;
      const done = new Promise((resolve, reject) => {
        waiter = resolve;
        setTimeout(() => reject(new Error(`turn timed out: ${text}\n${stderr.slice(-500)}`)), timeoutMs);
      });
      p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
      const result = await done;
      return { result, requests: api.requests.slice(before).map(inspect) };
    },
    close() {
      p.stdin.end();
      return new Promise((r) => { const t = setTimeout(() => p.kill(), 5000); p.on('close', () => { clearTimeout(t); r(); }); });
    },
  };
}

async function main() {
  const api = await startFakeApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-live-'));
  const local = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, JSON.stringify({
    permissions: { deny: ['Glob'] },
    skillOverrides: { dataviz: 'off' },
    enabledPlugins: { 'watch@claude-video': false },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'hello.md'), 'hi\n');

  const out = {};
  const s = await session(dir, { api });
  try {
    const call = 'CALL Glob {"pattern":"*.md"}';
    const t1 = await s.turn(call);
    const r1 = t1.requests.at(-1);
    out.before = {
      globInTools: t1.requests[0].tools.includes('Glob'),
      globResult: r1.toolResults.at(-1),
      datavizListed: t1.requests[0].has('- dataviz'),
      watchListed: t1.requests[0].has('watch:watch'),
    };

    // Remove every trim while the session is running.
    fs.writeFileSync(local, '{}\n');
    await sleep(3000);
    const t2 = await s.turn(call);
    const r2 = t2.requests.at(-1);
    out.afterEdit = {
      globInTools: t2.requests[0].tools.includes('Glob'),
      globResult: r2.toolResults.at(-1),
      datavizListed: t2.requests[0].has('- dataviz'),
      watchListed: t2.requests[0].has('watch:watch'),
    };

    const ts = await s.turn('CALL ToolSearch {"query":"select:Glob","max_results":5}');
    out.toolSearchAfterEdit = { result: ts.requests.at(-1).toolResults.at(-1), nextTools: ts.requests.at(-1).tools.includes('Glob') };
    const sk = await s.turn('CALL Skill {"skill":"dataviz"}');
    out.skillAfterEdit = sk.requests.at(-1).toolResults.at(-1);
    out.skillAfterEdit.anyDatavizText = sk.requests.at(-1).has('dataviz');
    const t3 = await s.turn('/reload-plugins');
    out.reloadPlugins = { requests: t3.requests.length, result: String(t3.result.result ?? '').slice(0, 200) };
    const t4 = await s.turn('CALL Skill {"skill":"watch:watch"}');
    out.watchSkillAfterReload = t4.requests.at(-1)?.toolResults.at(-1);
    out.afterReload = {
      watchListed: t4.requests[0]?.has('watch:watch'),
      globInTools: t4.requests[0]?.tools.includes('Glob'),
    };
  } catch (e) {
    out.error = String(e.message ?? e);
  } finally {
    await s.close();
    api.close();
  }
  console.log(JSON.stringify(out, null, 2));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the dir briefly */ }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('live-reload.mjs')) {
  main();
}
