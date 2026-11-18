// M5 acceptance on this OS (spec §14): clean install from the marketplace on a "fresh machine", then use it with and
// without Node.js on PATH. Everything is isolated: a temporary CLAUDE_CONFIG_DIR (a fake API key via apiKeyHelper,
// no plugins, no login), a temporary CTX_HOME, scratch projects, and the fake API. The real config is never touched.
// Needs a standalone build for the no-Node part: npm run build:bin (skipped with a note if missing).
// Run: node test/e2e/fresh-install.mjs   (2-3 minutes)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi } from './fake-api.mjs';
import { session } from './live-reload.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = process.env.CTX_CLAUDE_BIN ?? process.env.CLAUDE_CODE_EXECPATH ?? 'claude';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx fresh ')); // a space, like many home folders
const cfg = path.join(base, 'config');
const proj = path.join(base, 'my project');
fs.mkdirSync(cfg, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'README.md'), '# demo\n');
fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo sk-fake-key' }));

const exe = process.platform === 'win32' ? '.exe' : '';
const standalone = path.join(repo, 'release', `ctx-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}${exe}`);

// A terminal-like environment: no Claude Code session variables inherited from the editor running this script.
const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, CTX_HOME: path.join(base, 'ctx-state'), CTX_CLAUDE_BIN: bin };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT']) delete env[k];
const sep = process.platform === 'win32' ? ';' : ':';
const nodeDirs = (env.PATH ?? env.Path ?? '').split(sep).filter((d) => d && fs.existsSync(path.join(d, `node${exe}`)));
const noNodePath = (env.PATH ?? env.Path ?? '').split(sep).filter((d) => !nodeDirs.includes(d)).join(sep);

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failed++; };
const claude = (...args) => spawnSync(bin, args, { cwd: proj, env, encoding: 'utf8', shell: false, timeout: 120_000 });
const oneLine = (s) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);

async function withSession(extraEnv, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env, extraEnv);
  const api = await startFakeApi();
  const s = await session(proj, { api });
  try { await fn(s, api); } finally {
    await s.close();
    api.close();
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
const lastResult = (t) => t.requests.flatMap((r) => r.toolResults).at(-1);
const hookOutputs = (s, event) => s.events.filter((e) => e.subtype === 'hook_response' && e.hook_event === event);

try {
  // 1. Install from the marketplace in this repo.
  const add = claude('plugin', 'marketplace', 'add', repo);
  check('marketplace add', add.status === 0, oneLine(add.stdout + add.stderr));
  const inst = claude('plugin', 'install', 'ctx@ctx');
  check('plugin install ctx@ctx', inst.status === 0, oneLine(inst.stdout + inst.stderr));
  const installed = JSON.parse(fs.readFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), 'utf8')).plugins?.['ctx@ctx']?.[0];
  check('installed under the temp config', !!installed?.installPath && fs.existsSync(path.join(installed.installPath, 'bin', 'ctx')), installed?.installPath);
  const user = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  check('enabled in (temp) user settings', user.enabledPlugins?.['ctx@ctx'] === true);

  // 2. With Node on PATH: hooks run, the model sees only ctx:enable, user skills work without a permission prompt.
  await withSession({}, async (s) => {
    const t1 = await s.turn('hello');
    const starts = hookOutputs(s, 'SessionStart');
    check('SessionStart hook ran (node)', starts.length > 0 && starts.every((h) => h.exit_code === 0), starts.map((h) => h.outcome).join(','));
    // Silent UserPromptSubmit runs aren't reported in the stream (auto-trigger.mjs shows the hook fires); here it
    // must not surface errors or output.
    check('UserPromptSubmit hook silent', !s.events.some((e) => /UserPromptSubmit/.test(JSON.stringify(e))));
    const req = t1.requests.at(-1);
    check('only ctx:enable listed for the model', req.has('ctx:enable') && !req.has('ctx:setup') && !req.has('ctx:doctor'));
    const t2 = await s.turn('/ctx:doctor');
    const r = lastResult(t2);
    check('/ctx:doctor runs without approval (node)', !!r && !r.is_error && /runtime: node v/.test(r.content), oneLine(r?.content));
  });

  // 3. Without Node on PATH and without a standalone build: quiet hooks, one hint, a clear error.
  await withSession({ PATH: noNodePath, Path: noNodePath }, async (s) => {
    await s.turn('hello');
    const hint = s.events.find((e) => JSON.stringify(e).includes('ctx needs Node.js 20+'));
    check('no runtime: one SessionStart hint', !!hint);
    check('no runtime: hooks still exit 0', [...hookOutputs(s, 'SessionStart'), ...hookOutputs(s, 'UserPromptSubmit')].every((h) => h.exit_code === 0));
    const r = lastResult(await s.turn('/ctx:doctor'));
    check('no runtime: skill explains what is missing', /needs Node\.js 20 or later/.test(r?.content ?? ''), oneLine(r?.content));
  });

  // 4. Without Node, with the standalone build in ~/.claude/ctx/bin (here: the temp config).
  if (!fs.existsSync(standalone)) {
    console.log(`SKIP  standalone checks: ${path.relative(repo, standalone)} missing (npm run build:bin)`);
  } else {
    fs.mkdirSync(path.join(cfg, 'ctx', 'bin'), { recursive: true });
    fs.copyFileSync(standalone, path.join(cfg, 'ctx', 'bin', path.basename(standalone)));
    await withSession({ PATH: noNodePath, Path: noNodePath }, async (s) => {
      await s.turn('hello');
      check('standalone: SessionStart ok, no hint', hookOutputs(s, 'SessionStart').every((h) => h.exit_code === 0)
        && !s.events.some((e) => JSON.stringify(e).includes('ctx needs Node.js')));
      const d = lastResult(await s.turn('/ctx:doctor'));
      check('standalone: /ctx:doctor', /runtime: standalone build/.test(d?.content ?? ''), oneLine(d?.content));
      // The full measure path (spawns claude, request-capture stub) inside the standalone build.
      const rep = lastResult(await s.turn('/ctx:report', 300_000));
      const repLine = (rep?.text ?? '').split('\n').find((l) => l.startsWith('Upfront per new session'));
      check('standalone: /ctx:report measures and reports', !!repLine && !rep.is_error, repLine ?? oneLine(rep?.text?.slice(-300)));
    });
  }

  // 5. Uninstall leaves nothing running.
  const un = claude('plugin', 'uninstall', 'ctx@ctx');
  check('plugin uninstall', un.status === 0, oneLine(un.stdout + un.stderr));
  await withSession({}, async (s) => {
    await s.turn('hello');
    check('after uninstall: no ctx hooks', hookOutputs(s, 'SessionStart').length === 0 && hookOutputs(s, 'UserPromptSubmit').length === 0);
  });
} catch (e) {
  check('run', false, String(e.stack ?? e));
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* Windows file locks */ }
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
