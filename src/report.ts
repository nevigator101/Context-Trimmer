import type { Measurement, RunSummary } from './measure.js';
import { protectedIds } from './protect.js';
import { isBareToolRule, loadScopes, type SettingsFile } from './settings.js';
import { fmtK, fmtK1 } from './tokens.js';
import type { Ledger } from './usage.js';

const WIDTH = 100;

/** Join parts with " · ", wrapping at WIDTH with a hanging indent. */
export function wrapJoin(prefix: string, parts: string[], indent = prefix.length): string {
  const lines: string[] = [];
  let cur = prefix;
  for (let i = 0; i < parts.length; i++) {
    const piece = (i === 0 ? '' : ' · ') + parts[i];
    if (cur.length + piece.length > WIDTH && cur.trim().length > prefix.trim().length) {
      lines.push(cur);
      cur = ' '.repeat(indent) + parts[i];
    } else {
      cur += piece;
    }
  }
  lines.push(cur);
  return lines.join('\n');
}

export interface ActiveTrims {
  tools: { name: string; scope: string }[];
  plugins: { id: string; scope: string }[];
  skills: { name: string; level: string; scope: string }[];
}

/** Trim rules currently in effect, with the scope each one lives in. */
export function activeTrims(scopes: SettingsFile[]): ActiveTrims {
  const out: ActiveTrims = { tools: [], plugins: [], skills: [] };
  const pluginState = new Map<string, { v: boolean; scope: string }>();
  const skillState = new Map<string, { v: string; scope: string }>();
  for (const s of scopes) {
    const d = s.data;
    if (!d) continue;
    const perms = d.permissions as { deny?: unknown[] } | undefined;
    for (const r of perms?.deny ?? []) if (isBareToolRule(r) && !out.tools.some((t) => t.name === r)) out.tools.push({ name: r, scope: s.scope });
    const ep = d.enabledPlugins as Record<string, unknown> | undefined;
    if (ep && typeof ep === 'object') for (const [k, v] of Object.entries(ep)) if (typeof v === 'boolean') pluginState.set(k, { v, scope: s.scope });
    const so = d.skillOverrides as Record<string, unknown> | undefined;
    if (so && typeof so === 'object') for (const [k, v] of Object.entries(so)) if (typeof v === 'string') skillState.set(k, { v, scope: s.scope });
  }
  for (const [id, st] of pluginState) if (!st.v) out.plugins.push({ id, scope: st.scope });
  for (const [name, st] of skillState) if (st.v !== 'on') out.skills.push({ name, level: st.v, scope: st.scope });
  return out;
}

/** Category breakdown of a run with the skills quirk taken out of "System tools". */
export function correctedCategories(run: RunSummary, ref: RunSummary, quirk: boolean): Record<string, number> {
  const c = { ...run.categories };
  if (quirk && c['System tools'] !== undefined) {
    c['System tools'] -= (ref.categories['Skills'] ?? 0) - (c['Skills'] ?? 0);
  }
  return c;
}

function pct(from: number, to: number): string {
  if (!from) return '';
  return `${Math.round(((to - from) / from) * 100)}%`;
}

export function renderReport(root: string, m: Measurement, ledger: Ledger | undefined): string {
  const out: string[] = [];
  const scopes = loadScopes(root);
  const trims = activeTrims(scopes);
  const date = m.measuredAt.slice(0, 10);
  out.push(`ctx report: ${m.project}   (Claude Code ${m.ccVersion}, measured ${date})`);
  out.push('');

  const cur = m.current.correctedTokens;
  const ref = m.reference.correctedTokens;
  const headline = cur < ref
    ? `Upfront per new session: ${fmtK(cur)} (untrimmed ${fmtK(ref)}, ${pct(ref, cur)})`
    : `Upfront per new session: ${fmtK(cur)} (nothing trimmed)`;
  out.push(headline);
  if (m.skillsQuirk && m.current.totalTokens !== m.current.correctedTokens) {
    out.push(`  (/context shows ${fmtK(m.current.totalTokens)}: its total doesn't subtract skill and plugin trims.)`);
  }

  const cats = correctedCategories(m.current, m.reference, m.skillsQuirk);
  const tools = Object.entries(m.items)
    .filter(([id, it]) => id.startsWith('tool:') && it.deltaTokens > 0 && !trims.tools.some((t) => `tool:${t.name}` === id))
    .sort((a, b) => b[1].deltaTokens - a[1].deltaTokens)
    .map(([id, it]) => `${id.slice(5)} ${fmtK1(it.deltaTokens)}`);
  const row = (label: string, v: number | undefined, note = '') =>
    `  ${label.padEnd(18)} ${fmtK1(v ?? 0).padStart(6)}${note ? '   ' + note : ''}`;
  out.push(row('System prompt', cats['System prompt']));
  out.push(wrapJoin(row('Built-in tools', cats['System tools']) + '   deny saves: ', tools.slice(0, 6), 30) + (tools.length > 6 ? ' · ...' : ''));
  const skillLevels = trims.skills.reduce<Record<string, number>>((a, s) => ((a[s.level] = (a[s.level] ?? 0) + 1), a), {});
  out.push(row('Skills', cats['Skills'], Object.entries(skillLevels).map(([k, n]) => `${n} ${k}`).join(', ')));
  const mcpUp = (cats['MCP tools'] ?? 0) + (cats['MCP server instructions'] ?? 0);
  const servers = Object.keys(m.mcpServers).length;
  out.push(row('MCP', mcpUp, servers ? `${servers} server${servers === 1 ? '' : 's'}, tools deferred` : ''));
  out.push(row('Memory files', cats['Memory files'], m.memoryFiles.length ? `${m.memoryFiles.length} file${m.memoryFiles.length === 1 ? '' : 's'}` : ''));
  out.push('');

  // What is switched off now, and where. Flag items that were used recently (spec S2).
  const usedNote = (id: string) => {
    const n = ledger?.items[id]?.sessionsUsed ?? 0;
    return n ? `, USED in ${n} recent session${n === 1 ? '' : 's'}` : '';
  };
  const off: string[] = [];
  for (const t of trims.tools) off.push(`tool ${t.name} (${fmtK1(m.items[`tool:${t.name}`]?.deltaTokens ?? 0)}${t.scope !== 'local' ? `, ${t.scope}` : ''}${usedNote(`tool:${t.name}`)})`);
  for (const p of trims.plugins) off.push(`plugin ${p.id.split('@')[0]} (${fmtK1(m.items[`plugin:${p.id}`]?.deltaTokens ?? 0)}${p.scope !== 'local' ? `, ${p.scope}` : ''})`);
  const offSkills = trims.skills.filter((s) => s.level === 'off');
  for (const s of offSkills) off.push(`skill ${s.name} (off)`);
  out.push(off.length ? wrapJoin('Switched off:  ', off) : 'Switched off:  nothing');

  // Usage.
  if (ledger) {
    const used = Object.entries(ledger.items)
      .filter(([id]) => id.startsWith('tool:') || id.startsWith('skill:') || id.startsWith('mcp:'))
      .sort((a, b) => b[1].sessionsUsed - a[1].sessionsUsed || b[1].calls - a[1].calls)
      .map(([id, u]) => `${id.replace(/^tool:/, '').replace(/^skill:/, 'skill ').replace(/^mcp:/, 'mcp ')} ${u.sessionsUsed}`);
    out.push(wrapJoin(`Usage, last ${ledger.sessions.length} sessions (sessions used): `, used.slice(0, 14), 2) + (used.length > 14 ? ' · ...' : ''));
  } else {
    out.push('Usage: not collected yet (ctx usage).');
  }

  // Suggestions: unused, not protected, still on, cost >= 200.
  const prot = protectedIds({ ledger });
  const trimmedIds = new Set([
    ...trims.tools.map((t) => `tool:${t.name}`),
    ...trims.plugins.map((p) => `plugin:${p.id}`),
    ...trims.skills.map((s) => `skill:${s.name}`),
  ]);
  const usedPlugins = new Set(Object.keys(ledger?.items ?? {}).filter((id) => id.startsWith('skill:') && id.includes(':', 6))
    .map((id) => id.slice(6).split(':')[0]));
  const sugg = Object.entries(m.items)
    .filter(([id, it]) => (it.kind === 'tool' || it.kind === 'plugin' || it.kind === 'skill') && !prot.has(id) && !trimmedIds.has(id))
    .filter(([id]) => !(ledger?.items[id]?.sessionsUsed))
    .filter(([id]) => !(id.startsWith('plugin:') && usedPlugins.has(id.slice(7).split('@')[0])))
    .map(([id, it]) => ({ id, save: it.kind === 'skill' ? it.softDeltaTokens ?? 0 : it.deltaTokens }))
    .filter((s) => s.save >= 200)
    .sort((a, b) => b.save - a.save)
    .map((s) => `${s.id} ${fmtK1(s.save)}`);
  out.push(sugg.length ? wrapJoin('Unused here, >=200 tokens: ', sugg) : 'Suggestions: none above 200 tokens.');
  out.push(`Measured ${m.measuredAt.slice(0, 16).replace('T', ' ')} UTC · re-measure: ctx measure --full`);
  return out.join('\n');
}
