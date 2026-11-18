// M4 acceptance (spec §14): "Switching between two profiled projects loads each one's extras only in that project."
// Real claude binary, temporary CLAUDE_CONFIG_DIR (the real plugin installs are referenced, never modified), two
// scratch projects with synthetic transcripts: A uses the cloudflare plugin, B uses the watch plugin.
// `ctx global` switches both off in user settings and keeps each on in its own project; /context in each project
// must list only that project's extra. Then `ctx global undo` must restore the user settings byte for byte.
// No model calls, no quota. Run: node test/e2e/global-switch.mjs   (about 1 minute)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = process.env.CTX_CLAUDE_BIN ?? process.env.CLAUDE_CODE_EXECPATH ?? 'claude';
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ctx', 'dist', 'ctx.mjs');
const realCfg = path.join(os.homedir(), '.claude');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-global-'));
const cfg = path.join(base, 'cfg');
const A = path.join(base, 'proj A');
const B = path.join(base, 'proj B');
const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, CTX_HOME: path.join(base, 'state'), MSYS_NO_PATHCONV: '1' };
delete env.CLAUDE_PROJECT_DIR;

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failed++; };

fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
for (const f of ['installed_plugins.json', 'known_marketplaces.json']) fs.copyFileSync(path.join(realCfg, 'plugins', f), path.join(cfg, 'plugins', f));
const USER = JSON.stringify({ enabledPlugins: { 'cloudflare@cloudflare': true, 'watch@claude-video': true } }, null, 2) + '\n';
fs.writeFileSync(path.join(cfg, 'settings.json'), USER);

const slug = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
function transcript(root, skill, prompt) {
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(cfg, 'projects', slug(root));
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const lines = [
    { type: 'user', cwd: root, timestamp: ts, message: { role: 'user', content: prompt } },
    { type: 'assistant', cwd: root, timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Skill', input: { skill } }] } },
  ];
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
transcript(A, 'cloudflare:wrangler', 'deploy the worker with wrangler');
transcript(B, 'watch:watch', 'watch this video');

const ctx = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
function skills(root) {
  const r = spawnSync(bin, ['-p', '--no-session-persistence', '--output-format', 'json', '/context'], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 120_000,
  });
  const md = JSON.parse(r.stdout).result ?? '';
  return { cloudflare: /\| cloudflare:/.test(md), watch: /\| watch:watch \|/.test(md) };
}

try {
  const before = [skills(A), skills(B)];
  check('before: both extras load in both projects', before.every((s) => s.cloudflare && s.watch), JSON.stringify(before));

  const plan = ctx('global', '--min-tokens', '50');
  check('global plan', plan.status === 0 && /cloudflare@cloudflare.*off/.test(plan.stdout) && /watch@claude-video.*off/.test(plan.stdout),
    plan.stdout.split('\n').filter((l) => /plugin:/.test(l)).join(' | ') + plan.stderr.slice(-200));
  const ap = ctx('global', 'apply', '--yes');
  check('global apply', ap.status === 0, ap.stdout.split('\n').slice(0, 3).join(' | ') + ap.stderr.slice(-200));

  const a = skills(A);
  const b = skills(B);
  check('project A loads cloudflare only', a.cloudflare && !a.watch, JSON.stringify(a));
  check('project B loads watch only', b.watch && !b.cloudflare, JSON.stringify(b));

  const hook = spawnSync(process.execPath, [cli, 'hook', 'session-start', '--project', B], { encoding: 'utf8', env, input: '{}' });
  const ctxText = hook.stdout ? JSON.parse(hook.stdout).hookSpecificOutput?.additionalContext ?? '' : '';
  check('B session start lists cloudflare as switched off', /- cloudflare plugin/.test(ctxText) && !/watch plugin/.test(ctxText), ctxText.split('\n')[1]);

  const onB = ctx('on', 'cloudflare', '--project', B);
  check('ctx on cloudflare in B: local override', onB.status === 0 && skills(B).cloudflare, onB.stdout.split('\n')[0]);

  const un = ctx('global', 'undo');
  check('global undo', un.status === 0, un.stdout.split('\n').at(-2));
  check('user settings restored byte for byte', fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8') === USER);
  check('A keep-on removed', !fs.existsSync(path.join(A, '.claude', 'settings.local.json')));
  const bLocal = path.join(B, '.claude', 'settings.local.json');
  // B's override came from `ctx on`, not from ctx global, so undo leaves it (it now matches the user default).
  check('B override from ctx on kept', fs.existsSync(bLocal) && JSON.parse(fs.readFileSync(bLocal, 'utf8')).enabledPlugins?.['cloudflare@cloudflare'] === true);
  const after = [skills(A), skills(B)];
  check('after undo: both extras load in both projects', after.every((s) => s.cloudflare && s.watch), JSON.stringify(after));
} catch (e) {
  check('run', false, String(e.message ?? e));
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* Windows */ }
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
