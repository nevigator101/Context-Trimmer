// Regenerates the terminal samples in ctx/README.md from a throwaway setup: a temporary CLAUDE_CONFIG_DIR that
// references this machine's installed plugins (read only), two scratch projects with synthetic session history, and
// the real claude binary for measuring (no model calls). Paths are replaced with ~/code/... in the output.
// Run: node test/e2e/demo.mjs > demo.txt   (about 1 minute)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ctx', 'dist', 'ctx.mjs');
const realCfg = path.join(os.homedir(), '.claude');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-demo-'));
const cfg = path.join(base, 'cfg');
const app = path.join(base, 'code', 'demo-app');
const site = path.join(base, 'code', 'site');
const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, CTX_HOME: path.join(base, 'state'), MSYS_NO_PATHCONV: '1' };
for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDECODE']) delete env[k];

fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
for (const f of ['installed_plugins.json', 'known_marketplaces.json']) {
  try { fs.copyFileSync(path.join(realCfg, 'plugins', f), path.join(cfg, 'plugins', f)); } catch { /* none */ }
}
fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { 'cloudflare@cloudflare': true, 'watch@claude-video': true } }, null, 2));

const slug = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
function history(root, sessions) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo","private":true}\n');
  const dir = path.join(cfg, 'projects', slug(root));
  fs.mkdirSync(dir, { recursive: true });
  sessions.forEach((tools, i) => {
    const ts = new Date(Date.now() - (sessions.length - i) * 3600_000).toISOString();
    const lines = [{ type: 'user', cwd: root, timestamp: ts, message: { role: 'user', content: 'work on it' } }];
    for (const [name, input] of tools) {
      lines.push({ type: 'assistant', cwd: root, timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] } });
    }
    fs.writeFileSync(path.join(dir, `s${i}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
}
const code = [['Read', {}], ['Edit', {}], ['Bash', {}], ['Grep', {}], ['Glob', {}]];
history(app, [code, [...code, ['Write', {}]], code, [...code, ['Skill', { skill: 'watch:watch' }]], code, code]);
history(site, [code, [...code, ['Skill', { skill: 'cloudflare:wrangler' }]], [...code, ['Skill', { skill: 'watch:watch' }]]]);

const variants = (p) => {
  const fwd = p.replace(/\\/g, '/');
  return [p, fwd, fwd.replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`), slug(p)];
};
const swaps = [...variants(path.join(base, 'code')).map((v) => [v, '~/code']), ...variants(base).map((v) => [v, '~'])];
const clean = (s) => swaps.reduce((t, [from, to]) => t.split(from).join(to), s)
  .replace(/~[^\s)]*/g, (m) => m.replace(/\\/g, '/'));

function run(title, args, cwd) {
  const r = spawnSync(process.execPath, [cli, ...args, '--project', cwd], { env, encoding: 'utf8' });
  console.log(`\n$ ctx ${title}\n${clean(r.stdout).trimEnd()}`);
  if (r.status !== 0) console.log(clean(r.stderr).trimEnd());
}

try {
  for (const p of [app, site]) {
    spawnSync(process.execPath, [cli, 'measure', '--full', '--project', p], { env, encoding: 'utf8' });
    spawnSync(process.execPath, [cli, 'usage', '--project', p], { env, encoding: 'utf8' });
  }
  run('plan', ['plan'], app);
  run('apply --yes --groups tools,plugins,skills', ['apply', '--yes', '--groups', 'tools,plugins,skills'], app);
  run('report', ['report'], app);
  run('on artifact', ['on', 'artifact'], app);
  run('global', ['global'], app);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
