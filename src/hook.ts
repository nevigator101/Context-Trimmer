// Hook entry points (spec §3.3, §9.1). SessionStart must be fast (S5: < 300 ms): cached data only, no measuring,
// no writes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import deps from './deps.json' with { type: 'json' };
import { loadMeasurement, type Measurement } from './measure.js';
import { buildPlan, groupSummary } from './plan.js';
import { loadProfile } from './profile.js';
import { protectedIds } from './protect.js';
import { activeTrims } from './report.js';
import { loadScopes, type SettingsFile } from './settings.js';
import { fmtK } from './tokens.js';
import { loadLedger } from './usage.js';
import { loadApplied, ownedRefs } from './writer.js';

const DEPS = deps as unknown as Record<string, { skills?: string[]; note?: string }>;
/** Spec §9.1: keep the index under 400 tokens (~4 chars per token). */
const INDEX_MAX_CHARS = 1500;
export const INDEX_HEADER = 'Switched off in this project to save context (ask or use /ctx:enable to turn one on):';

export interface HookInput { cwd?: string; source?: string; session_id?: string; }

export function readHookInput(): HookInput {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    return {};
  }
}

interface IndexEntry { label: string; desc: string; }

/** Hard-off items in the project's local settings, with one-line descriptions. */
export function hardOffEntries(m: Measurement | undefined, scopes: SettingsFile[]): IndexEntry[] {
  const local = scopes.filter((s) => s.scope === 'local');
  const trims = activeTrims(local);
  const out: IndexEntry[] = [];
  for (const t of trims.tools) {
    const id = `tool:${t.name}`;
    const note = DEPS[id]?.note;
    const desc = m?.items[id]?.description ?? '';
    out.push({ label: `${t.name} tool`, desc: note ? `${desc}${desc ? ' ' : ''}(${note})` : desc });
  }
  for (const p of trims.plugins) {
    const name = p.id.split('@')[0];
    out.push({ label: `${name} plugin`, desc: m?.items[`plugin:${p.id}`]?.description ?? '' });
  }
  for (const s of trims.skills) {
    if (s.level !== 'off' && s.level !== 'user-invocable-only') continue; // name-only skills are still listed
    out.push({ label: `${s.name} skill`, desc: m?.skillDescriptions?.[s.name] ?? '' });
  }
  return out;
}

export function capabilityIndex(entries: IndexEntry[]): string | undefined {
  if (!entries.length) return undefined;
  const lines = [INDEX_HEADER];
  let chars = INDEX_HEADER.length;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const line = `- ${e.label}${e.desc ? `: ${e.desc}` : ''}`;
    if (chars + line.length > INDEX_MAX_CHARS) {
      lines.push(`- ... and ${entries.length - i} more (see /ctx:report)`);
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join('\n');
}

export interface SessionStartOutput { systemMessage?: string; hookSpecificOutput?: { hookEventName: 'SessionStart'; additionalContext: string }; }

export function sessionStart(root: string): SessionStartOutput {
  const m = loadMeasurement(root);
  const scopes = loadScopes(root);
  const applied = loadApplied(root);
  const index = capabilityIndex(hardOffEntries(m, scopes));
  const out: SessionStartOutput = {};
  if (index) out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: index };

  const owned = ownedRefs(applied).length;
  const trims = activeTrims(scopes.filter((s) => s.scope === 'local'));
  const nOff = trims.tools.length + trims.plugins.length + trims.skills.length;
  if (owned && m) {
    out.systemMessage = `ctx: lean profile active (${fmtK(m.current.correctedTokens)} upfront, ${nOff} items trimmed). /ctx:report for details.`;
  } else if (m && !owned) {
    const threshold = Number(process.env.CTX_SUGGEST_THRESHOLD ?? 20_000);
    if (m.current.correctedTokens > threshold) {
      const ledger = loadLedger(root);
      const profile = loadProfile(root);
      const plan = buildPlan(m, ledger, profile, { protectedIds: protectedIds({ ledger, keep: profile?.keep }) });
      const save = groupSummary(plan).filter((g) => ['tools', 'plugins', 'skills'].includes(g.group)).reduce((a, g) => a + g.tokens, 0);
      if (save >= 1000) out.systemMessage = `ctx: this project loads ${fmtK(m.current.correctedTokens)} upfront; /ctx:setup could cut ~${fmtK(save)}.`;
    }
  }
  return out;
}

/** SessionEnd: refresh the usage ledger in a detached process so the session closes immediately. */
export function sessionEnd(root: string, cliPath: string): void {
  if (!loadMeasurement(root) && !loadLedger(root)) return; // project never profiled; nothing to refresh
  const child = spawn(process.execPath, [cliPath, 'usage', '--quiet', '--project', root], {
    detached: true, stdio: 'ignore', windowsHide: true, shell: false,
  });
  child.unref();
}
