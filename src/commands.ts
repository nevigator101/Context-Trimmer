// apply / on / off / undo / verify orchestration (spec §8, §9.2).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadMeasurement, measurementPath, verifyRun, type Measurement } from './measure.js';
import { projectKey, readJson, writeJson } from './paths.js';
import { loadPlan, type Group, type Plan } from './plan.js';
import { protectedIds } from './protect.js';
import { resolveItem, knownIds } from './resolve.js';
import { findRule, loadScopes } from './settings.js';
import { fmtK } from './tokens.js';
import { ledgerPath, loadLedger, type Ledger } from './usage.js';
import {
  clearEntry, describeRef, ENABLE_RULE, isKeepOn, loadApplied, ownedRefs, refKey, setEntry, undo as undoWrite, writeSettings,
  appliedPath, globalTarget, type Applied, type EntryRef,
} from './writer.js';
import { loadProfile } from './profile.js';

export const DEFAULT_GROUPS: Group[] = ['tools', 'plugins', 'skills'];

type Out = (line: string) => void;

function refsForPlan(plan: Plan, groups: Group[]): EntryRef[] {
  const refs: EntryRef[] = [];
  for (const i of plan.items) {
    if (!i.group || !groups.includes(i.group) || (i.action !== 'off' && i.action !== 'soft')) continue;
    const name = i.id.slice(i.id.indexOf(':') + 1);
    if (i.kind === 'tool' && i.action === 'off') refs.push({ kind: 'tool', name });
    else if (i.kind === 'plugin' && i.action === 'off') refs.push({ kind: 'plugin', id: name });
    else if (i.kind === 'skill') refs.push({ kind: 'skill', name, level: i.action === 'off' ? 'off' : 'name-only' });
  }
  return refs;
}

/** Warn when settings.local.json would be committed (spec §8.1 rule 1). */
export function gitIgnoreStatus(root: string): 'ignored' | 'not-ignored' | 'no-repo' {
  try {
    const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', path.join('.claude', 'settings.local.json')], {
      shell: false, windowsHide: true, stdio: 'ignore', timeout: 10_000,
    });
    return r.status === 0 ? 'ignored' : r.status === 1 ? 'not-ignored' : 'no-repo';
  } catch {
    return 'no-repo';
  }
}

export function addGitExclude(root: string): boolean {
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { shell: false, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return false;
  const file = path.resolve(root, r.stdout.trim());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!cur.split(/\r?\n/).includes('.claude/settings.local.json')) {
    fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}.claude/settings.local.json\n`);
  }
  return true;
}

export interface ApplyOptions {
  groups?: Group[]; yes?: boolean; planFile?: string; verify?: boolean; gitExclude?: boolean;
  /** Add the allow rule Skill(ctx:enable) so Claude can re-enable items without a permission prompt. */
  allowEnable?: boolean;
}

/** `ctx allow-enable [--remove]`: let Claude invoke /ctx:enable without asking (an owned, undoable allow rule). */
export function allowEnable(root: string, remove: boolean, out: Out): number {
  const ref: EntryRef = { kind: 'allow', rule: ENABLE_RULE };
  const res = writeSettings(root, remove ? 'disallow enable' : 'allow enable', (s, a) => {
    if (remove) return clearEntry(s, a, ref) === 'removed' ? [`removed allow ${ENABLE_RULE}`] : [];
    const c = setEntry(s, a, ref);
    return c ? [c] : [];
  });
  if (!res.changes.length) out(remove ? `${ENABLE_RULE} isn't set by ctx; nothing removed.` : `${ENABLE_RULE} is already allowed.`);
  else out(remove
    ? `Removed ${ENABLE_RULE}: Claude will ask before switching items back on.`
    : `Added ${ENABLE_RULE} to ${res.file}: Claude can switch trimmed items back on when a task needs them, without asking.`);
  return 0;
}

export async function apply(root: string, opts: ApplyOptions, out: Out): Promise<number> {
  const plan = opts.planFile ? readJson<Plan>(path.resolve(opts.planFile)) : loadPlan(root);
  if (!plan) { out('No plan yet. Run: ctx plan'); return 2; }
  const m = loadMeasurement(root);
  if (!m) { out('No measurement yet. Run: ctx measure'); return 2; }
  const groups = opts.groups ?? DEFAULT_GROUPS;
  const desired = refsForPlan(plan, groups);
  const desiredKeys = new Set(desired.map(refKey));

  const mutation = (s: Record<string, unknown>, a: Applied): string[] => {
    const changes: string[] = [];
    // Converge: drop owned entries the plan no longer wants (except ones the user switched off with `ctx off`).
    const pinned = new Set(a.pinnedOff ?? []);
    for (const r of ownedRefs(a)) {
      // Keep-on overrides belong to `ctx on` / `ctx global`, not to the plan.
      if (r.kind === 'allow' || isKeepOn(r) || desiredKeys.has(refKey(r)) || pinned.has(refKey(r))) continue;
      if (clearEntry(s, a, r) === 'removed') changes.push(`removed ${describeRef(r)} (no longer planned)`);
    }
    for (const r of desired) {
      const c = setEntry(s, a, r);
      if (c) changes.push(c);
    }
    if (opts.allowEnable) {
      const c = setEntry(s, a, { kind: 'allow', rule: ENABLE_RULE });
      if (c) changes.push(`${c} (Claude may switch items back on when a task needs them)`);
    }
    return changes;
  };

  if (!opts.yes) {
    // Dry run on copies.
    const settings = readJson<Record<string, unknown>>(path.join(root, '.claude', 'settings.local.json')) ?? {};
    const changes = mutation(JSON.parse(JSON.stringify(settings)) as Record<string, unknown>, JSON.parse(JSON.stringify(loadApplied(root))) as Applied);
    out(`Dry run (groups: ${groups.join(', ')}). ${changes.length} change(s) to .claude/settings.local.json:`);
    for (const c of changes) out(`  ${c}`);
    out('Run again with --yes to write them.');
    return 0;
  }

  const res = writeSettings(root, `apply ${groups.join(',')}`, mutation);
  const skipped = res.changes.filter((c) => c.startsWith('skipped'));
  const applied = res.changes.filter((c) => !c.startsWith('skipped'));
  out(applied.length ? `Wrote ${applied.length} change(s) to ${res.file} (backup ${res.backup}).` : 'Settings already match the plan; nothing written.');
  for (const c of res.changes) out(`  ${c}`);
  if (skipped.length) out('Skipped entries hold a value you set yourself; ctx leaves them alone.');

  const git = gitIgnoreStatus(root);
  if (git === 'not-ignored') {
    if (opts.gitExclude && addGitExclude(root)) out('Added .claude/settings.local.json to .git/info/exclude.');
    else out('Warning: .claude/settings.local.json is not git-ignored. Re-run with --git-exclude to add it to .git/info/exclude.');
  }

  if (opts.verify !== false) await verifyAndRecord(root, m, out);
  return 0;
}

/** One verification /context run of the current settings; records the result (spec §3.2 step 6). */
export async function verifyAndRecord(root: string, m: Measurement, out: Out): Promise<void> {
  const before = m.current.correctedTokens;
  try {
    const now = await verifyRun(root, {}, m.reference, m.skillsQuirk);
    const a = loadApplied(root);
    a.verified = { at: new Date().toISOString(), beforeTokens: before, afterTokens: now.correctedTokens, rawAfterTokens: now.totalTokens };
    writeJson(appliedPath(root), a);
    const fresh = loadMeasurement(root);
    if (fresh) { fresh.current = now; writeJson(measurementPath(root), fresh); }
    out(`Upfront context for new sessions: ${fmtK(before)} -> ${fmtK(now.correctedTokens)} (untrimmed ${fmtK(m.reference.correctedTokens)})`
      + (m.skillsQuirk && now.totalTokens !== now.correctedTokens ? `; /context will show ${fmtK(now.totalTokens)}` : '') + '.');
    out('Start a new session (/clear or a new chat) to use it. This session keeps the tools it started with.');
  } catch (e) {
    out(`Verification run failed: ${(e as Error).message}. Settings were written; run ctx measure to check.`);
  }
}

function refForId(id: string, level: 'name-only' | 'off' = 'name-only'): EntryRef | undefined {
  const name = id.slice(id.indexOf(':') + 1);
  if (id.startsWith('tool:')) return { kind: 'tool', name };
  if (id.startsWith('plugin:')) return { kind: 'plugin', id: name };
  if (id.startsWith('skill:')) return { kind: 'skill', name, level };
  return undefined;
}

function resolveOrExplain(root: string, query: string, out: Out): string | undefined {
  const m = loadMeasurement(root);
  const ids = knownIds(m, loadScopes(root), loadApplied(root));
  const r = resolveItem(query, ids);
  if (r.id) return r.id;
  if (r.candidates.length) {
    out(`"${query}" matches several items; use one of:`);
    for (const c of r.candidates) out(`  ${c}`);
  } else {
    out(`No item named "${query}". Known items include: ${ids.filter((i) => !i.startsWith('mcp:')).slice(0, 12).join(', ')} ...`);
  }
  return undefined;
}

function recordReenable(root: string, id: string, reason?: string): void {
  // Start a ledger if there is none yet; `ctx usage` keeps reenables when it rebuilds.
  const l: Ledger = loadLedger(root) ?? {
    project: projectKey(root), builtAt: new Date().toISOString(), sessionsScanned: 0, window: { sessions: 10 },
    sessions: [], items: {}, reenables: {}, global: { skillUsage: {}, pluginUsage: {} },
  };
  (l.reenables[id] ??= []).push(new Date().toISOString() + (reason ? ` ${reason.slice(0, 120)}` : ''));
  l.reenables[id] = l.reenables[id].slice(-10);
  writeJson(ledgerPath(root), l);
}

function howItApplies(id: string, m: Measurement | undefined): string[] {
  const name = id.slice(id.indexOf(':') + 1);
  if (id.startsWith('tool:')) {
    const lines = [
      `${name} can be called from now on, but it stays out of this session's tool list until /clear or a new session.`,
    ];
    const schema = m?.toolSchemas?.[name];
    if (schema) {
      const s = JSON.stringify(schema);
      lines.push(`${name} input schema (call the tool with arguments matching it):`);
      lines.push(s.length > 4000 ? `${s.slice(0, 4000)}... (truncated)` : s);
    }
    return lines;
  }
  if (id.startsWith('plugin:')) return ['Run /reload-plugins to load it in this session (new sessions load it automatically).'];
  if (id.startsWith('skill:')) return [`Skill ${name} can be invoked by name now; its full description returns in new sessions.`];
  return [];
}

export interface OnOptions { force?: boolean; reason?: string; }

export function on(root: string, query: string, opts: OnOptions, out: Out): number {
  let id = resolveOrExplain(root, query, out);
  if (!id) return 2;
  if (id.startsWith('mcp:')) {
    out(`${id} is an MCP server. Toggle it with /mcp (ctx doesn't edit ~/.claude.json).`);
    return 0;
  }
  // A plugin skill is switched on through its plugin.
  const m = loadMeasurement(root);
  const pluginSkill = id.startsWith('skill:') && m?.skills.find((s) => `skill:${s.name}` === id)?.plugin;
  if (pluginSkill) {
    const pid = Object.keys(m?.items ?? {}).find((k) => k.startsWith(`plugin:${pluginSkill}@`));
    if (pid) { out(`${id} belongs to plugin ${pid.slice(7)}; switching the plugin on.`); id = pid; }
  }
  const ref = refForId(id);
  if (!ref) { out(`Can't switch ${id} on.`); return 2; }

  let result: string = 'absent';
  const res = writeSettings(root, `on ${id}`, (s, a) => {
    const r = clearEntry(s, a, ref, !!opts.force);
    result = r;
    if (r === 'removed') {
      a.pinnedOff = (a.pinnedOff ?? []).filter((k) => k !== refKey(ref));
      return [`removed ${describeRef(ref)}`];
    }
    return [];
  });

  if (result === 'removed') {
    out(`${id} is on again (${res.file}, backup ${res.backup}).`);
    for (const l of howItApplies(id, m)) out(l);
    recordReenable(root, id, opts.reason);
    // Claude Code hot-reloads settings within about a second; wait so an immediate next call already works.
    if (id.startsWith('tool:') && process.env.CLAUDECODE) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    return 0;
  }
  if (result === 'not-owned') {
    out(`${id} is switched off in .claude/settings.local.json, but not by ctx. Run "ctx on ${query} --force" to remove that entry (a backup is kept).`);
    return 1;
  }
  const scopes = loadScopes(root);
  const where = ref.kind === 'tool' ? findRule(scopes, 'deny', ref.name)
    : ref.kind === 'plugin' ? findRule(scopes, 'plugin', ref.id)
      : ref.kind === 'skill' ? findRule(scopes, 'skill', ref.name) : [];
  const other = where.filter((s) => s.scope !== 'local');
  const key = ref.kind === 'tool' ? `permissions.deny "${ref.name}"` : ref.kind === 'plugin' ? `enabledPlugins["${ref.id}"]` : ref.kind === 'skill' ? `skillOverrides["${ref.name}"]` : '';
  // A plugin or skill switched off in user or shared project settings: a project-local value overrides it
  // (VERIFY.md items 8 and 26), so switch it on for this project without touching the other file.
  const overridable = other.filter((s) => s.scope === 'user' || s.scope === 'project');
  if ((ref.kind === 'plugin' || ref.kind === 'skill') && overridable.length && !other.some((s) => s.scope === 'managed')) {
    const keep: EntryRef = ref.kind === 'plugin' ? { kind: 'plugin', id: ref.id, value: true } : { kind: 'skill', name: ref.name, level: 'on' };
    let skipped: string | undefined;
    const w = writeSettings(root, `on ${id}`, (s, a) => {
      const c = setEntry(s, a, keep);
      if (c?.startsWith('skipped')) { skipped = c; return []; }
      return c ? [c] : [];
    });
    if (skipped) { out(`${skipped}. ${id} stays as you set it in ${w.file}.`); return 1; }
    const src = overridable[0];
    const byCtx = src.scope === 'user' && key && isGlobalOwned(ref);
    out(`${id} is switched off in ${src.path} (${src.scope} settings${byCtx ? ', by ctx global' : ''}), key ${key}. `
      + (w.changes.length ? `Added a project-local override in ${w.file} (backup ${w.backup}), so it is on in this project only.`
        : `This project already overrides it locally.`));
    for (const l of howItApplies(id, m)) out(l);
    if (w.changes.length) recordReenable(root, id, opts.reason);
    return 0;
  }
  if (other.length) {
    for (const s of other) out(`${id} is switched off in ${s.path} (${s.scope} settings), key ${key}. ctx doesn't edit that file; change it there.`);
    return 1;
  }
  out(`${id} is already on.`);
  return 0;
}

/** Was this entry written to user settings by `ctx global`? */
function isGlobalOwned(ref: EntryRef): boolean {
  const g = loadApplied(globalTarget());
  if (ref.kind === 'plugin') return g.owned.plugins[ref.id] === false;
  if (ref.kind === 'skill') return ref.name in g.owned.skills;
  return false;
}

export interface OffOptions { force?: boolean; level?: 'name-only' | 'off'; }

export function off(root: string, query: string, opts: OffOptions, out: Out): number {
  const id = resolveOrExplain(root, query, out);
  if (!id) return 2;
  if (id.startsWith('mcp:')) { out(`${id} is an MCP server. Toggle it with /mcp.`); return 0; }
  const m = loadMeasurement(root);
  if (id.startsWith('skill:') && m?.skills.find((s) => `skill:${s.name}` === id)?.plugin) {
    out(`${id} is a plugin skill; plugin skills can't be switched off one by one. Switch off its plugin instead.`);
    return 1;
  }
  const prot = protectedIds({ ledger: loadLedger(root), keep: loadProfile(root)?.keep });
  if (prot.has(id) && !opts.force) {
    out(`${id} is protected${id === 'tool:Skill' || id === 'tool:ToolSearch' ? ' (denying it makes context larger)' : ''}. Use --force to switch it off anyway.`);
    return 1;
  }
  const ref = refForId(id, opts.level ?? 'name-only');
  if (!ref) { out(`Can't switch ${id} off.`); return 2; }
  const res = writeSettings(root, `off ${id}`, (s, a) => {
    const c = setEntry(s, a, ref);
    if (c && !c.startsWith('skipped')) a.pinnedOff = [...new Set([...(a.pinnedOff ?? []), refKey(ref)])];
    return c ? [c] : [];
  });
  if (!res.changes.length) { out(`${id} is already off.`); return 0; }
  if (res.changes[0].startsWith('skipped')) { out(res.changes[0]); return 1; }
  const save = m?.items[id];
  out(`${describeRef(ref)} written to ${res.file} (backup ${res.backup})${save ? `; saves about ${fmtK(ref.kind === 'skill' && ref.level === 'name-only' ? save.softDeltaTokens ?? 0 : save.deltaTokens)} per new session` : ''}.`);
  if (ref.kind === 'plugin') out('Takes effect in new sessions, or run /reload-plugins.');
  else out('Takes effect in new sessions.');
  return 0;
}

export function undo(root: string, all: boolean, out: Out): number {
  try {
    const r = undoWrite(root, all);
    out(all
      ? (r.deleted ? 'Restored the original state: .claude/settings.local.json did not exist before ctx, so it was removed.' : `Restored the original .claude/settings.local.json (backup ${r.restored}).`)
      : `Restored .claude/settings.local.json from backup ${r.restored}${r.deleted ? ' (the file did not exist then, so it was removed)' : ''}.`);
    if (r.manualEditsSaved) out(`The file had edits made after ctx's last write; they were saved to backups/${r.manualEditsSaved}.`);
    out('New sessions use the restored settings.');
    return 0;
  } catch (e) {
    out((e as Error).message);
    return 1;
  }
}
