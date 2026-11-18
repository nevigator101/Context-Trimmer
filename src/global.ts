// Cross-project baseline, `ctx global` (spec §3.4). Plugins and skills used in only some projects go off (plugins)
// or to name-only (skills) in ~/.claude/settings.json, and get a project-local keep-on override in the projects that
// use them. A project-local value overrides the user-level one (VERIFY.md items 8 and 26). Built-in tools are out of
// scope: a user-level deny can't be overridden per project.
import path from 'node:path';
import { loadMeasurement } from './measure.js';
import { claudeDir, ctxHome, projectKey, readJson, writeJson } from './paths.js';
import { loadProfile } from './profile.js';
import { discoverProjects, type KnownProject } from './registry.js';
import { firstSentence } from './runner.js';
import { loadScopes, pluginDescriptions, type Json } from './settings.js';
import { fmtK1 } from './tokens.js';
import { readGlobalCounters, scanLedger, type Ledger } from './usage.js';
import { wrapJoin } from './report.js';
import {
  appliedPath, clearEntry, describeRef, globalTarget, loadApplied, ownedRefs, refFromKey, refKey, setEntry, writeSettings,
  type EntryRef,
} from './writer.js';

export type GlobalClass = 'common' | 'extra' | 'unused' | 'elsewhere' | 'protected' | 'negligible' | 'user-set';

export interface GlobalItem {
  id: string;
  kind: 'plugin' | 'skill';
  /** Upfront tokens saved per session where the item is off (plugins: off; skills: name-only). Undefined = unmeasured. */
  tokens?: number;
  /** Project keys that used the item in their usage window (or pin it in their profile). */
  usedIn: string[];
  /** Project roots that get a local keep-on override when the item goes off globally. */
  keepOn: string[];
  class: GlobalClass;
  action: 'off' | 'soft' | 'none';
  reason: string;
  description?: string;
}

export interface ProjectUse {
  key: string;
  root: string;
  lastActive?: string;
  sessions: number;
  active: boolean;
  exists: boolean;
  registered: boolean;
  /** Candidate item ids this project used. */
  uses: string[];
}

export interface GlobalPlan {
  createdAt: string;
  windowSessions: number;
  activeDays: number;
  share: number;
  projects: ProjectUse[];
  items: GlobalItem[];
  notes: string[];
}

export interface GlobalOptions {
  /** Sessions per project to scan (default 10). */
  sessions?: number;
  /** Projects with a session in the last N days count as active (default 90). */
  days?: number;
  /** An item used by more than this share of active projects stays on everywhere (default 0.5). */
  share?: number;
  /** Plugins below this cost are left alone (default 200 tokens; skills use a quarter of it). */
  minTokens?: number;
}

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const nameOf = (id: string) => id.slice(id.indexOf(':') + 1);
/** Skill sources that a user-level skillOverrides entry applies to. Project skills and plugin skills are excluded. */
const GLOBAL_SKILL_SOURCES = new Set(['Built-in', 'claude.ai sync', 'User']);

export function globalPlanPath(): string { return path.join(ctxHome(), 'global', 'plan.json'); }
export function loadGlobalPlan(): GlobalPlan | undefined { return readJson<GlobalPlan>(globalPlanPath()); }

/** Did this project use the item? Plugins count through their skills, agents and MCP servers. */
export function projectUses(l: Ledger | undefined, id: string, keep: string[] = []): boolean {
  if (keep.includes(id)) return true;
  if (!l) return false;
  if ((l.reenables[id]?.length ?? 0) > 0) return true;
  if (id.startsWith('plugin:')) {
    const p = nameOf(id).split('@')[0];
    return Object.entries(l.items).some(([k, u]) => u.sessionsUsed > 0
      && (k.startsWith(`skill:${p}:`) || k.startsWith(`agent:${p}:`) || k.startsWith(`mcp:plugin_${p}_`)));
  }
  return (l.items[id]?.sessionsUsed ?? 0) > 0;
}

/** User-scope plugins: user-scope installs plus entries in ~/.claude/settings.json. Value = enabled there. */
export function userPlugins(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const inst = readJson<{ plugins?: Record<string, { scope?: string }[]> }>(path.join(claudeDir(), 'plugins', 'installed_plugins.json'));
  for (const [id, installs] of Object.entries(inst?.plugins ?? {})) if (installs.some((i) => i.scope === 'user')) out[id] = true;
  const us = readJson<Json>(path.join(claudeDir(), 'settings.json'));
  if (isObj(us?.enabledPlugins)) for (const [id, v] of Object.entries(us.enabledPlugins)) if (typeof v === 'boolean') out[id] = v;
  return out;
}

export async function buildGlobalPlan(opts: GlobalOptions = {}, found?: KnownProject[]): Promise<GlobalPlan> {
  const window = opts.sessions ?? 10;
  const days = opts.days ?? 90;
  const share = opts.share ?? 0.5;
  const min = opts.minTokens ?? 200;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const projects = (found ?? await discoverProjects()).filter((p) => p.exists);
  const g = loadApplied(globalTarget());
  const prev = loadGlobalPlan();
  const notes: string[] = [];

  // Candidates and their costs (max over the projects' cached measurements; plugins switched off by ctx global
  // aren't measured any more, so fall back to the previous plan).
  const cost = new Map<string, number>();
  const skillSources = new Map<string, string>();
  const bump = (id: string, v: number | undefined) => { if (v !== undefined) cost.set(id, Math.max(cost.get(id) ?? 0, v)); };
  for (const p of projects) {
    const m = loadMeasurement(p.root);
    if (!m) continue;
    for (const [id, it] of Object.entries(m.items)) {
      if (it.unmeasured) continue;
      if (it.kind === 'plugin') bump(id, it.deltaTokens);
      if (it.kind === 'skill' && GLOBAL_SKILL_SOURCES.has(it.source ?? '')) { bump(id, it.softDeltaTokens ?? 0); skillSources.set(id, it.source ?? ''); }
    }
  }
  for (const it of prev?.items ?? []) if (!cost.has(it.id) && it.tokens !== undefined) cost.set(it.id, it.tokens);

  const ids = new Set<string>();
  const plugins = userPlugins();
  for (const id of Object.keys(plugins)) ids.add(`plugin:${id}`);
  for (const id of Object.keys(g.owned.plugins)) ids.add(`plugin:${id}`);
  for (const id of skillSources.keys()) ids.add(id);
  for (const s of Object.keys(g.owned.skills)) ids.add(`skill:${s}`);

  // Usage per project.
  const uses: ProjectUse[] = [];
  for (const p of projects) {
    const l = p.dirs.length ? await scanLedger(p.root, { dirs: p.dirs, sessions: window }) : undefined;
    const keep = loadProfile(p.root)?.keep ?? [];
    uses.push({
      key: p.key, root: p.root, lastActive: p.lastActive, sessions: l?.sessions.length ?? 0,
      active: !!p.lastActive && p.lastActive >= since && (l?.sessions.length ?? 0) > 0,
      exists: p.exists, registered: p.registered,
      uses: [...ids].filter((id) => projectUses(l, id, keep)),
    });
  }
  const active = uses.filter((u) => u.active);
  const counters = readGlobalCounters();
  const descs = pluginDescriptions();
  const userSettings = readJson<Json>(path.join(claudeDir(), 'settings.json')) ?? {};
  const userSkills = isObj(userSettings.skillOverrides) ? userSettings.skillOverrides : {};

  const items: GlobalItem[] = [];
  for (const id of ids) {
    const kind = id.startsWith('plugin:') ? 'plugin' : 'skill';
    const name = nameOf(id);
    const usedBy = uses.filter((u) => u.uses.includes(id));
    const activeUsers = usedBy.filter((u) => u.active);
    const tokens = cost.get(id);
    const item: GlobalItem = {
      id, kind, tokens, usedIn: usedBy.map((u) => u.key), keepOn: [], class: 'negligible', action: 'none', reason: '',
      ...(kind === 'plugin' && descs[name] ? { description: firstSentence(descs[name]) } : {}),
    };
    const set = (c: GlobalClass, reason: string, action: GlobalItem['action'] = 'none') => Object.assign(item, { class: c, reason, action });
    const offAction = kind === 'plugin' ? 'off' : 'soft';
    const ownedByCtx = kind === 'plugin' ? g.owned.plugins[name] === false : name in g.owned.skills;

    if (kind === 'plugin' && name.split('@')[0] === 'ctx') set('protected', 'ctx itself (its hooks must run everywhere)');
    else if (kind === 'plugin' && plugins[name] === false && !ownedByCtx) set('user-set', 'off in your user settings');
    else if (kind === 'skill' && name in userSkills && !ownedByCtx) set('user-set', `set to "${String(userSkills[name])}" in your user settings`);
    else if (tokens !== undefined && tokens < (kind === 'plugin' ? min : min / 4)) set('negligible', `${fmtK1(tokens)} per session`);
    else if (!usedBy.length) {
      const c = kind === 'plugin' ? counters.pluginUsage[name] : counters.skillUsage[name] ?? counters.skillUsage[`anthropic-skills:${name}`];
      const last = c?.lastUsedAt ? new Date(c.lastUsedAt).toISOString() : '';
      if (last && last >= since) set('elsewhere', `used ${last.slice(0, 10)} in a session ctx can't map to a project`);
      else set('unused', `not used in any of ${uses.length} projects`, offAction);
    } else if (activeUsers.length > share * active.length) {
      set('common', `used in ${activeUsers.length} of ${active.length} active projects`);
    } else {
      set('extra', `used only in ${usedBy.map((u) => shortName(u.key)).join(', ')}`, offAction);
      item.keepOn = usedBy.map((u) => u.root);
    }
    items.push(item);
  }

  if (active.length < 2) notes.push(`Only ${active.length} active project${active.length === 1 ? '' : 's'}: per-project trimming (/ctx:setup) does more than a global baseline.`);
  if (!cost.size) notes.push('No project has been measured yet, so costs are unknown. Run /ctx:setup (or ctx measure) in a project first.');
  const unmeasured = items.filter((i) => i.action !== 'none' && i.tokens === undefined);
  if (unmeasured.length) notes.push(`Unmeasured: ${unmeasured.map((i) => nameOf(i.id)).join(', ')} (cost unknown; measure a project that loads them).`);

  const plan: GlobalPlan = {
    createdAt: new Date().toISOString(), windowSessions: window, activeDays: days, share,
    projects: uses, items: items.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || a.id.localeCompare(b.id)), notes,
  };
  writeJson(globalPlanPath(), plan);
  return plan;
}

function shortName(key: string): string {
  const parts = key.split('/');
  return parts[parts.length - 1] || key;
}

export function renderGlobalPlan(plan: GlobalPlan): string {
  const out: string[] = [];
  const active = plan.projects.filter((p) => p.active);
  out.push(`ctx global: ${active.length} active project${active.length === 1 ? '' : 's'} (session in the last ${plan.activeDays} days), `
    + `${plan.windowSessions} sessions each`);
  for (const p of plan.projects) {
    out.push(`  ${p.key.padEnd(48).slice(0, 48)} ${String(p.sessions).padStart(3)} sessions  last ${p.lastActive?.slice(0, 10) ?? '-'}`
      + `${p.registered ? '  profiled' : ''}${p.active ? '' : '  (inactive)'}`);
  }
  out.push('');
  const trims = plan.items.filter((i) => i.action !== 'none');
  const plug = trims.filter((i) => i.kind === 'plugin');
  const sk = trims.filter((i) => i.kind === 'skill');
  const line = (i: GlobalItem) => `  ${i.id.padEnd(34)} ${(i.tokens === undefined ? '?' : fmtK1(i.tokens)).padStart(6)}  ${i.action.padEnd(4)}  ${i.reason}`.slice(0, 100);
  if (plug.length) {
    out.push('[plugins] Off in user settings; on again in the projects that use them');
    for (const i of plug) out.push(line(i));
    out.push('');
  }
  if (sk.length) {
    out.push('[skills] Name-only in user settings (still callable by name); fully on where used');
    for (const i of sk) out.push(line(i));
    out.push('');
  }
  if (!trims.length) out.push('Nothing to change: every plugin and skill is used widely, already off, or too small to matter.');
  const keep = plan.items.filter((i) => i.action === 'none' && i.class !== 'negligible');
  if (keep.length) out.push(wrapJoin('Left alone: ', keep.map((i) => `${nameOf(i.id).split('@')[0]} (${i.class})`)));
  for (const n of plan.notes) out.push(`Note: ${n}`);
  const keepOns = trims.reduce((a, i) => a + i.keepOn.length, 0);
  out.push(`Writes ~/.claude/settings.json${keepOns ? ` and ${keepOns} keep-on override${keepOns === 1 ? '' : 's'} in project settings.local.json files` : ''}. `
    + 'Savings apply per new session in every project where the item is off.');
  return out.join('\n');
}

const keepRef = (i: GlobalItem): EntryRef =>
  i.kind === 'plugin' ? { kind: 'plugin', id: nameOf(i.id), value: true } : { kind: 'skill', name: nameOf(i.id), level: 'on' };
const offRef = (i: GlobalItem): EntryRef =>
  i.kind === 'plugin' ? { kind: 'plugin', id: nameOf(i.id) } : { kind: 'skill', name: nameOf(i.id), level: 'name-only' };
const idOfRef = (r: EntryRef) => (r.kind === 'plugin' ? `plugin:${r.id}` : r.kind === 'skill' ? `skill:${r.name}` : '');

/** The project's own local settings already trim the item: that choice wins, no keep-on needed. */
function locallyTrimmed(s: Json, i: GlobalItem): boolean {
  const n = nameOf(i.id);
  if (i.kind === 'plugin') return isObj(s.enabledPlugins) && s.enabledPlugins[n] === false;
  return isObj(s.skillOverrides) && n in s.skillOverrides && s.skillOverrides[n] !== 'on';
}

type Out = (line: string) => void;

export interface ApplyGlobalOptions { yes?: boolean; items?: string[]; }

/**
 * Write the global baseline. Order: keep-on overrides in projects first (harmless on their own), then user settings;
 * an item whose keep-on can't be written stays on globally. Finally, keep-ons for items no longer off are removed.
 */
export function applyGlobal(plan: GlobalPlan, opts: ApplyGlobalOptions, out: Out): number {
  const unknown = (opts.items ?? []).filter((id) => !plan.items.some((i) => i.id === id));
  if (unknown.length) { out(`Not in the global plan: ${unknown.join(', ')}`); return 2; }
  const chosen = plan.items.filter((i) => i.action !== 'none' && (!opts.items || opts.items.includes(i.id)));
  const gt = globalTarget();
  const g = loadApplied(gt);

  if (!opts.yes) {
    const removals = ownedRefs(g).filter((r) => !chosen.some((i) => refKey(offRef(i)) === refKey(r)));
    out(`Dry run. ~/.claude/settings.json: ${chosen.length} item(s) off or name-only${removals.length ? `, ${removals.length} earlier ctx entr${removals.length === 1 ? 'y' : 'ies'} removed` : ''}.`);
    for (const i of chosen) out(`  ${describeRef(offRef(i))}${i.keepOn.length ? `; on in ${i.keepOn.map((r) => shortName(projectKey(r))).join(', ')}` : ''}`);
    for (const r of removals) out(`  remove ${describeRef(r)} (no longer planned)`);
    out('Run again with --yes to write them.');
    return 0;
  }

  const failed = new Set<string>();
  const projects: Record<string, string[]> = { ...(g.projects ?? {}) };
  const byRoot = new Map<string, GlobalItem[]>();
  for (const i of chosen) for (const r of i.keepOn) byRoot.set(r, [...(byRoot.get(r) ?? []), i]);
  for (const [root, its] of byRoot) {
    try {
      const res = writeSettings(root, 'global keep-on', (s, a) => {
        const changes: string[] = [];
        for (const i of its) {
          if (locallyTrimmed(s, i)) continue;
          const ref = keepRef(i);
          const c = setEntry(s, a, ref);
          if (c?.startsWith('skipped')) { failed.add(i.id); out(`${shortName(projectKey(root))}: ${c}; ${nameOf(i.id)} stays on globally.`); continue; }
          const owned = ref.kind === 'plugin' ? a.owned.plugins[ref.id] === true : ref.kind === 'skill' && a.owned.skills[ref.name] === 'on';
          if (owned) projects[root] = [...new Set([...(projects[root] ?? []), refKey(ref)])];
          if (c) changes.push(c);
        }
        return changes;
      });
      if (res.changes.length) out(`${projectKey(root)}: ${res.changes.join('; ')}`);
    } catch (e) {
      for (const i of its) failed.add(i.id);
      out(`${projectKey(root)}: ${(e as Error).message}. Leaving ${its.map((i) => nameOf(i.id)).join(', ')} on globally.`);
    }
  }

  const desired = chosen.filter((i) => !failed.has(i.id));
  const desiredKeys = new Set(desired.map((i) => refKey(offRef(i))));
  const res = writeSettings(gt, 'global', (s, a) => {
    const changes: string[] = [];
    for (const r of ownedRefs(a)) {
      if (desiredKeys.has(refKey(r))) continue;
      if (clearEntry(s, a, r) === 'removed') changes.push(`removed ${describeRef(r)}`);
    }
    for (const i of desired) {
      const c = setEntry(s, a, offRef(i), { replace: (cur) => i.kind === 'plugin' && cur === true });
      if (c) changes.push(c);
    }
    return changes;
  });
  out(res.changes.length ? `${res.file}: ${res.changes.join('; ')} (backup ${res.backup})` : `${res.file}: already matches the plan.`);

  // Keep-ons for items that are no longer off globally are not needed.
  const after = loadApplied(gt);
  const offNow = new Set(ownedRefs(after).map(idOfRef));
  pruneKeepOns(projects, (id) => !offNow.has(id), out);

  after.projects = projects;
  after.descriptions = Object.fromEntries(desired.filter((i) => i.description).map((i) => [i.id, i.description!]));
  writeJson(appliedPath(gt), after);
  const saved = desired.reduce((a, i) => a + (i.tokens ?? 0), 0);
  out(`Global baseline: ${desired.length} item(s) off or name-only, about ${fmtK1(saved)} less per new session in projects that don't use them.`);
  out('Projects that use an item keep it through their local override. Start new sessions to see the effect; /ctx:global undo reverts.');
  return 0;
}

/** Remove keep-on overrides (owned by ctx) whose item matches `drop`. Mutates `projects`. */
function pruneKeepOns(projects: Record<string, string[]>, drop: (id: string) => boolean, out: Out): void {
  for (const [root, keys] of Object.entries(projects)) {
    const gone = keys.filter((k) => { const r = refFromKey(k); return r && drop(idOfRef(r)); });
    if (!gone.length) continue;
    try {
      const res = writeSettings(root, 'global prune', (s, a) => gone.flatMap((k) => {
        const r = refFromKey(k)!;
        return clearEntry(s, a, r) === 'removed' ? [`removed ${describeRef(r)}`] : [];
      }));
      if (res.changes.length) out(`${projectKey(root)}: ${res.changes.join('; ')}`);
      projects[root] = keys.filter((k) => !gone.includes(k));
      if (!projects[root].length) delete projects[root];
    } catch (e) {
      out(`${projectKey(root)}: ${(e as Error).message}; left its overrides in place.`);
    }
  }
}

/** Remove everything `ctx global` wrote: restore user settings values, then drop the projects' keep-on overrides. */
export function undoGlobal(out: Out): number {
  const gt = globalTarget();
  const g = loadApplied(gt);
  if (!ownedRefs(g).length && !Object.keys(g.projects ?? {}).length) { out('ctx global has nothing to undo.'); return 0; }
  const res = writeSettings(gt, 'global undo', (s, a) => ownedRefs(a).flatMap((r) =>
    (clearEntry(s, a, r) === 'removed' ? [`restored ${describeRef(r).replace(/ (off|name-only)$/, '')}`] : [])));
  if (res.changes.length) out(`${res.file}: ${res.changes.join('; ')} (backup ${res.backup})`);
  const projects = { ...(g.projects ?? {}) };
  pruneKeepOns(projects, () => true, out);
  const after = loadApplied(gt);
  after.projects = projects;
  after.descriptions = {};
  writeJson(appliedPath(gt), after);
  out(Object.keys(projects).length ? 'Some project overrides could not be removed (see above).' : 'Global baseline removed. New sessions load everything as before.');
  return 0;
}

/** Plugins ctx global switched off that are off in this project too (no local override), for the capability index. */
export function globalOffHere(root: string): { id: string; description: string }[] {
  const g = readJson<{ owned?: { plugins?: Record<string, boolean> }; descriptions?: Record<string, string> }>(appliedPath(globalTarget()));
  const off = Object.entries(g?.owned?.plugins ?? {}).filter(([, v]) => v === false).map(([id]) => id);
  if (!off.length) return [];
  const local = loadScopes(root).filter((s) => s.scope === 'project' || s.scope === 'local');
  return off.filter((id) => !local.some((s) => isObj(s.data?.enabledPlugins) && (s.data.enabledPlugins as Json)[id] === true))
    .map((id) => ({ id, description: g?.descriptions?.[`plugin:${id}`] ?? '' }));
}
