// Fuzzy item names for `ctx on` / `ctx off` (spec §10): "artifact", "Artifact", "tool:Artifact", "cloudflare".
import type { Measurement } from './measure.js';
import { activeTrims } from './report.js';
import type { SettingsFile } from './settings.js';
import type { Applied } from './writer.js';

export interface Resolution { id?: string; candidates: string[]; }

/** Every item id ctx knows about for this project. */
export function knownIds(m: Measurement | undefined, scopes: SettingsFile[], applied: Applied): string[] {
  const ids = new Set<string>();
  for (const id of Object.keys(m?.items ?? {})) if (!id.startsWith('memory:')) ids.add(id);
  for (const t of m?.upfrontTools ?? []) ids.add(`tool:${t}`);
  const trims = activeTrims(scopes);
  for (const t of trims.tools) ids.add(`tool:${t.name}`);
  for (const p of trims.plugins) ids.add(`plugin:${p.id}`);
  for (const s of trims.skills) ids.add(`skill:${s.name}`);
  for (const t of applied.owned.deny) ids.add(`tool:${t}`);
  for (const p of Object.keys(applied.owned.plugins)) ids.add(`plugin:${p}`);
  for (const s of Object.keys(applied.owned.skills)) ids.add(`skill:${s}`);
  return [...ids];
}

export function resolveItem(query: string, ids: string[]): Resolution {
  const q = query.trim();
  const ql = q.toLowerCase().replace(/^anthropic-skills:/, '');
  const exact = ids.find((id) => id === q);
  if (exact) return { id: exact, candidates: [exact] };
  const ci = ids.filter((id) => id.toLowerCase() === ql);
  if (ci.length === 1) return { id: ci[0], candidates: ci };
  // Name part: "Artifact" -> tool:Artifact; "cloudflare" -> plugin:cloudflare@cloudflare.
  const byName = ids.filter((id) => {
    const name = id.slice(id.indexOf(':') + 1).toLowerCase();
    return name === ql || name.split('@')[0] === ql;
  });
  if (byName.length === 1) return { id: byName[0], candidates: byName };
  if (byName.length > 1) {
    // Prefer kind given as a word: "tool Artifact" style is handled by the caller; otherwise ambiguous.
    return { candidates: byName };
  }
  const partial = ids.filter((id) => id.toLowerCase().includes(ql));
  if (partial.length === 1) return { id: partial[0], candidates: partial };
  return { candidates: partial.slice(0, 12) };
}
