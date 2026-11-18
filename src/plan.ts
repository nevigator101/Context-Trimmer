// Planner (spec §7.2): deterministic classification of every measured item into a proposed action.
import path from 'node:path';
import deps from './deps.json' with { type: 'json' };
import type { Measurement } from './measure.js';
import { projectKey, projectStateDir, readJson, writeJson } from './paths.js';
import { profileKeywords, type ProjectProfile } from './profile.js';
import { fmtK1 } from './tokens.js';
import { globalSkillCount, type Ledger } from './usage.js';
import { wrapJoin } from './report.js';

export type Action = 'none' | 'soft' | 'off' | 'suggest';
export type ItemClass = 'protected' | 'kept' | 'used' | 'needed' | 'likely' | 'rare' | 'foreign' | 'unused' | 'negligible' | 'mcp';
/** Confirmation groups (AskUserQuestion options). "rare" is opt-in: items used recently but rarely and costly. */
export type Group = 'tools' | 'plugins' | 'skills' | 'skills-off' | 'rare' | 'mcp';

export interface PlanItem {
  id: string;
  kind: 'tool' | 'plugin' | 'skill' | 'mcp';
  class: ItemClass;
  action: Action;
  /** Estimated tokens saved by the action (single-item measurement; not additive). */
  saveTokens: number;
  reason: string;
  group?: Group;
}

export interface Plan {
  project: string;
  createdAt: string;
  measuredAt: string;
  ccVersion: string;
  windowSessions: number;
  aggressive: boolean;
  minTokens: number;
  reviewed: boolean;
  notes: string[];
  items: PlanItem[];
}

export interface PlanOptions {
  aggressive?: boolean;
  /** Spec §7.2: items under this upfront cost are "negligible". */
  minTokens?: number;
  /** Used-but-rare items at or above this cost go to the opt-in "rare" group. */
  rareMinTokens?: number;
  protectedIds: Set<string>;
}

const DEPS = deps as unknown as Record<string, { skills?: string[] }>;

export function planPath(root: string): string { return path.join(projectStateDir(root), 'plan.json'); }
export function loadPlan(root: string): Plan | undefined { return readJson<Plan>(planPath(root)); }
export function savePlan(root: string, p: Plan): void { writeJson(planPath(root), p); }

function nameOf(id: string): string { return id.slice(id.indexOf(':') + 1); }
function pluginName(id: string): string { return nameOf(id).split('@')[0]; }

/** Was a plugin used in this project? Any of its skills, commands or agents. */
function pluginSessions(ledger: Ledger | undefined, plugin: string): number {
  if (!ledger) return 0;
  let n = 0;
  for (const [id, u] of Object.entries(ledger.items)) {
    if (id.startsWith(`skill:${plugin}:`) || id.startsWith(`agent:${plugin}:`)) n = Math.max(n, u.sessionsUsed);
  }
  return n;
}

function matchesSignal(id: string, keywords: string[]): string | undefined {
  const name = nameOf(id).toLowerCase();
  return keywords.find((k) => name.includes(k) || (k.length >= 4 && k.includes(name)));
}

export function buildPlan(m: Measurement, ledger: Ledger | undefined, profile: ProjectProfile | undefined, opts: PlanOptions): Plan {
  const min = opts.minTokens ?? 200;
  const rareMin = opts.rareMinTokens ?? 2000;
  const keywords = profileKeywords(profile);
  const window = ledger?.sessions.length ?? 0;
  const items: PlanItem[] = [];
  const notes: string[] = [];
  const used = (id: string) => ledger?.items[id]?.sessionsUsed ?? 0;
  // Re-enables inside the usage window (newer than its oldest session; all of them if there's no history).
  const windowStart = ledger?.sessions.length ? ledger.sessions.reduce((a, s) => (s.mtime < a ? s.mtime : a), ledger.sessions[0].mtime) : '';
  const reenabled = (id: string) => (ledger?.reenables[id] ?? []).filter((ts) => ts.slice(0, 24) >= windowStart).length;

  for (const [id, it] of Object.entries(m.items)) {
    if (it.kind === 'memory') continue;
    if (it.kind === 'mcp') {
      const n = used(id);
      items.push(n
        ? { id, kind: 'mcp', class: 'used', action: 'none', saveTokens: 0, reason: `used in ${n} of ${window} sessions` }
        : { id, kind: 'mcp', class: 'mcp', action: 'suggest', saveTokens: 0, group: 'mcp',
          reason: 'not used here; tools are deferred, so only names and instructions cost tokens. Toggle with /mcp' });
      continue;
    }
    const kind = it.kind as 'tool' | 'plugin' | 'skill';
    const full = it.deltaTokens;
    const soft = it.softDeltaTokens ?? 0;
    const sessions = kind === 'plugin' ? pluginSessions(ledger, pluginName(id)) : used(id);
    const push = (c: ItemClass, action: Action, reason: string, group?: Group) => {
      const saveTokens = action === 'none' ? 0 : kind === 'skill' && action === 'soft' ? soft : full;
      items.push({ id, kind, class: c, action, saveTokens, reason, ...(group ? { group } : {}) });
    };
    const offGroup: Group = kind === 'tool' ? 'tools' : kind === 'plugin' ? 'plugins' : 'skills-off';

    if (it.unmeasured) { push('negligible', 'none', `not measured (${it.unmeasured})`); continue; }
    if (opts.protectedIds.has(id)) { push('protected', 'none', 'protected'); continue; }
    if (profile?.keep?.includes(id)) { push('kept', 'none', 'pinned in the project profile'); continue; }
    if (reenabled(id) >= 1) { push('used', 'none', `re-enabled ${reenabled(id) === 1 ? 'once' : `${reenabled(id)} times`} recently`); continue; }
    if (sessions > 0) {
      if (kind !== 'skill' && full >= rareMin && sessions <= 1 && window >= 2) {
        push('rare', 'off', `used in only ${sessions} of ${window} sessions (opt-in)`, 'rare');
      } else {
        push('used', 'none', `used in ${sessions} of ${window} sessions`);
      }
      continue;
    }
    const signal = matchesSignal(id, keywords);
    if (signal) {
      if (kind === 'skill' && soft >= min / 4) push('likely', 'soft', `matches project signal "${signal}"`, 'skills');
      else push('likely', 'none', `matches project signal "${signal}"`);
      continue;
    }
    const global = kind === 'skill' ? globalSkillCount(ledger ?? emptyLedger(), nameOf(id))
      : kind === 'plugin' ? (ledger?.global.pluginUsage[nameOf(id)]?.usageCount ?? 0) : 0;
    if (global > 0) {
      if (kind === 'plugin' && full >= min / 2) { push('foreign', 'off', `used in other projects (${global}x), never here`, 'plugins'); continue; }
      if (kind === 'skill' && soft > 0 && full >= min / 4) { push('foreign', 'soft', `used in other projects (${global}x), never here`, 'skills'); continue; }
      push('negligible', 'none', `used elsewhere; ${fmtK1(full)} here`);
      continue;
    }
    if (full >= min) {
      if (kind === 'skill') {
        if (opts.aggressive) push('unused', 'off', 'never used', 'skills-off');
        else push('unused', 'soft', 'never used', 'skills');
      } else {
        push('unused', 'off', 'never used', offGroup);
      }
      continue;
    }
    push('negligible', 'none', `never used, ${fmtK1(full)}`);
  }

  // Dependencies: an item needed by a used/kept skill stays on; skills of an item going off go name-only with it.
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const [dep, d] of Object.entries(DEPS)) {
    const it = byId.get(dep);
    if (!it || it.action === 'none') continue;
    const keeper = (d.skills ?? []).find((s) => {
      const si = byId.get(`skill:${s}`);
      return si && ['protected', 'kept', 'used', 'likely'].includes(si.class) && si.action === 'none';
    });
    if (keeper) {
      Object.assign(it, { class: 'needed', action: 'none', saveTokens: 0, reason: `needed by skill ${keeper}` });
      delete it.group;
      continue;
    }
    for (const s of d.skills ?? []) {
      const si = byId.get(`skill:${s}`);
      if (si && si.action === 'none' && !['protected', 'kept', 'used'].includes(si.class)) {
        const mi = m.items[`skill:${s}`];
        Object.assign(si, { action: 'soft', saveTokens: mi?.softDeltaTokens ?? 0, reason: `goes with ${dep} (dependency)`, group: it.group });
      }
    }
  }

  const trimmed = items.filter((i) => i.action === 'off' || i.action === 'soft');
  if (!window) notes.push('No usage history for this project yet: every item counts as unused. Review the plan carefully.');
  if (trimmed.some((i) => i.group === 'rare')) notes.push('The "rare" group holds items you used recently; it is applied only if you select it.');

  return {
    project: m.project,
    createdAt: new Date().toISOString(),
    measuredAt: m.measuredAt,
    ccVersion: m.ccVersion,
    windowSessions: window,
    aggressive: !!opts.aggressive,
    minTokens: min,
    reviewed: false,
    notes,
    items: items.sort((a, b) => (b.saveTokens - a.saveTokens) || a.id.localeCompare(b.id)),
  };
}

function emptyLedger(): Ledger {
  return { project: '', builtAt: '', sessionsScanned: 0, window: { sessions: 0 }, sessions: [], items: {}, reenables: {}, global: { skillUsage: {}, pluginUsage: {} } };
}

const RANK: Record<Action, number> = { none: 0, suggest: 0, soft: 1, off: 2 };

/**
 * Apply Claude's review (spec §7.2): it may only make the plan more conservative, or move a skill from none to soft.
 * Accepts {"items":[{"id","action","reason"?}]} or a full plan. Returns the new plan and per-item rejections.
 */
export function reviewPlan(draft: Plan, reviewJson: string): { plan: Plan; rejected: string[]; changed: string[] } {
  let parsed: { items?: { id?: unknown; action?: unknown; reason?: unknown }[]; notes?: unknown };
  try {
    parsed = JSON.parse(reviewJson) as typeof parsed;
  } catch (e) {
    throw new Error(`plan --set expects JSON: ${(e as Error).message}`);
  }
  const plan: Plan = JSON.parse(JSON.stringify(draft)) as Plan;
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const rejected: string[] = [];
  const changed: string[] = [];
  for (const r of parsed.items ?? []) {
    const id = String(r.id ?? '');
    const action = String(r.action ?? '') as Action;
    const it = byId.get(id);
    if (!it) { rejected.push(`${id}: not in the plan`); continue; }
    if (!(action in RANK) || action === 'suggest') { rejected.push(`${id}: unknown action "${action}"`); continue; }
    if (action === it.action) continue;
    const ok = RANK[action] < RANK[it.action] || (it.action === 'none' && action === 'soft' && it.kind === 'skill' && it.class !== 'protected');
    if (!ok) { rejected.push(`${id}: ${it.action} -> ${action} would trim more than the rules allow`); continue; }
    if (action === 'soft' && it.kind !== 'skill') { rejected.push(`${id}: only skills have a soft level`); continue; }
    changed.push(`${id}: ${it.action} -> ${action}`);
    it.action = action;
    it.reason = typeof r.reason === 'string' && r.reason ? `review: ${r.reason}` : `review: ${it.action}`;
    if (action === 'none') { it.saveTokens = 0; delete it.group; }
    if (action === 'soft') { it.group = 'skills'; }
  }
  if (Array.isArray(parsed.notes)) plan.notes.push(...parsed.notes.filter((n): n is string => typeof n === 'string').map((n) => `review: ${n}`));
  plan.reviewed = true;
  return { plan, rejected, changed };
}

export const GROUP_LABEL: Record<Group, string> = {
  tools: 'Deny unused built-in tools',
  plugins: 'Switch off plugins not used here',
  skills: 'Unused skills to name-only (still callable by name)',
  'skills-off': 'Unused skills fully off (aggressive)',
  rare: 'Costly items used only once recently (opt-in)',
  mcp: 'MCP servers not used here (suggestion; toggle with /mcp)',
};

export function groupSummary(plan: Plan): { group: Group; items: PlanItem[]; tokens: number }[] {
  const order: Group[] = ['tools', 'plugins', 'skills', 'skills-off', 'rare', 'mcp'];
  return order.map((g) => {
    const items = plan.items.filter((i) => i.group === g && i.action !== 'none');
    return { group: g, items, tokens: items.reduce((a, i) => a + i.saveTokens, 0) };
  }).filter((g) => g.items.length);
}

export function renderPlan(plan: Plan, m: Measurement): string {
  const out: string[] = [];
  out.push(`ctx plan: ${projectKey(plan.project)}   (untrimmed ${fmtK1(m.reference.correctedTokens)}, `
    + `usage window ${plan.windowSessions} sessions${plan.aggressive ? ', aggressive' : ''}${plan.reviewed ? ', reviewed' : ''})`);
  out.push('');
  for (const g of groupSummary(plan)) {
    const est = g.group === 'mcp' ? '' : `   est. -${fmtK1(g.tokens)}`;
    out.push(`[${g.group}] ${GROUP_LABEL[g.group]}${est}`);
    for (const i of g.items) {
      out.push(`  ${i.id.padEnd(38)} ${i.group === 'mcp' ? '      ' : fmtK1(i.saveTokens).padStart(6)}  ${i.action.padEnd(5)} ${i.reason}`.slice(0, 100));
    }
    out.push('');
  }
  const keep = plan.items.filter((i) => i.action === 'none' && i.kind !== 'mcp' && ['used', 'protected', 'kept', 'needed', 'likely'].includes(i.class));
  out.push(wrapJoin('Kept on: ', keep.map((i) => `${nameOf(i.id)} (${i.class})`)));
  for (const n of plan.notes) out.push(`Note: ${n}`);
  out.push('Estimates come from single-item measurements and are not additive; apply reports the verified total.');
  return out.join('\n');
}
