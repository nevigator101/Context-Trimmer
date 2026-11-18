// End-to-end (spec §13, opt-in): real claude binary, scratch project.
// measure -> plan -> apply -> verify the total dropped -> on/off -> undo all -> verify it's restored byte for byte.
// Run: node test/e2e/apply-cycle.mjs   (about 1 minute; no model calls)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ctx', 'dist', 'ctx.mjs');
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx e2e '));
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-e2e-state-'));
const env = { ...process.env, CTX_HOME: state };
const local = path.join(proj, '.claude', 'settings.local.json');
const original = '{\n  "permissions": { "allow": ["Read"] }\n}\n';
fs.mkdirSync(path.dirname(local), { recursive: true });
fs.writeFileSync(local, original);

let failed = 0;
function run(...args) {
  const r = spawnSync(process.execPath, [cli, ...args, '--project', proj], { env, encoding: 'utf8', timeout: 400_000 });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
const tokens = (s) => { const m = s.match(/([\d.]+)K -> ([\d.]+)K/); return m ? [parseFloat(m[1]), parseFloat(m[2])] : null; };

const measure = run('measure', '--full');
check('measure', measure.code === 0, measure.out.split('\n').find((l) => l.startsWith('Untrimmed')));
const plan = run('plan');
check('plan', plan.code === 0 && plan.out.includes('[tools]'));
const apply = run('apply', '--yes');
const t = tokens(apply.out);
check('apply writes and verifies', apply.code === 0 && !!t && t[1] < t[0], t ? `${t[0]}K -> ${t[1]}K` : apply.out.slice(-300));
const written = JSON.parse(fs.readFileSync(local, 'utf8'));
check('unrelated keys kept', written.permissions?.allow?.[0] === 'Read');
check('protected tools not denied', !['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill', 'ToolSearch'].some((x) => written.permissions?.deny?.includes(x)));

const offR = run('off', 'gepeto');
const onR = run('on', 'gepeto');
check('off/on by fuzzy name', offR.code === 0 && onR.code === 0, `${offR.out.trim().split('\n')[0]} | ${onR.out.trim().split('\n')[0]}`);
const protectedOff = run('off', 'Bash');
check('protected item refused', protectedOff.code === 1 && /protected/.test(protectedOff.out));

const undo = run('undo', 'all');
check('undo all restores bytes', undo.code === 0 && fs.readFileSync(local, 'utf8') === original);
const verify = run('verify');
const v = tokens(verify.out);
check('total back to untrimmed', !!v && Math.abs(v[1] - parseFloat(measure.out.match(/Untrimmed: ([\d.]+)K/)?.[1] ?? '0')) <= 0.2, v ? `${v[1]}K` : verify.out.slice(-200));

fs.rmSync(proj, { recursive: true, force: true });
fs.rmSync(state, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
