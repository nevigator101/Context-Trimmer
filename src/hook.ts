// Hook entry points (spec §3.3, §9.1). SessionStart must be fast (S5: < 300 ms): cached data only, no measuring,
// no writes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import deps from './deps.json' with { type: 'json' };
import { on } from './commands.js';
import { globalOffHere } from './global.js';
import { DEFAULT_THRESHOLD, loadConfig, loadTriggers, scorePrompt, shortId } from './triggers.js';
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

export interface HookInput { cwd?: string; source?: string; session_id?: string; prompt?: string; }

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

/**
 * Hard-off items in the project's local settings, plus plugins `ctx global` switched off in user settings that this
 * project doesn't override, with one-line descriptions.
 */
export function hardOffEntries(m: Measurement | undefined, scopes: SettingsFile[], globalOff: { id: string; description: string }[] = []): IndexEntry[] {
  const local = scopes.filter((s) => s.scope === 'local');
  const trims = activeTrims(local);
  const out: IndexEntry[] = [];
  for (const g of globalOff) {
    if (trims.plugins.some((p) => p.id === g.id)) continue; // also off locally; listed below
    out.push({ label: `${g.id.split('@')[0]} plugin`, desc: g.description });
  }
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
  const index = capabilityIndex(hardOffEntries(m, scopes, globalOffHere(root)));
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

function spawnDetached(cliPath: string, args: string[]): void {
  const child = spawn(process.execPath, [cliPath, ...args], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  child.unref();
}

/** Re-learn triggers at most this often (they span all projects, so one refresh serves every session). */
const LEARN_EVERY_MS = 6 * 3600_000;

/**
 * SessionEnd: refresh the usage ledger (and, with auto on, the trigger table) in detached processes so the session
 * closes immediately.
 */
export function sessionEnd(root: string, cliPath: string): void {
  if (loadMeasurement(root) || loadLedger(root)) spawnDetached(cliPath, ['usage', '--quiet', '--project', root]);
  if (loadConfig().auto) {
    const t = loadTriggers();
    if (!t || Date.now() - Date.parse(t.learnedAt) > LEARN_EVERY_MS) spawnDetached(cliPath, ['triggers', 'learn', '--quiet']);
  }
}

/** Items switched off in this project that a trigger may switch back on: ctx-owned local trims and ctx global offs. */
export function offCandidates(root: string): string[] {
  const a = loadApplied(root);
  const ids = new Set<string>();
  for (const t of a.owned.deny) ids.add(`tool:${t}`);
  for (const [p, v] of Object.entries(a.owned.plugins)) if (v === false) ids.add(`plugin:${p}`);
  for (const [s, v] of Object.entries(a.owned.skills)) if (v === 'off') ids.add(`skill:${s}`);
  for (const g of globalOffHere(root)) ids.add(`plugin:${g.id}`);
  return [...ids];
}

export interface PromptSubmitOutput {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: 'UserPromptSubmit'; additionalContext: string };
}

/** At most this many items are switched on per prompt. */
const MAX_AUTO = 2;

/**
 * UserPromptSubmit (spec §9.3, opt-in): score the prompt against the project's switched-off items using the learned
 * trigger table; switch strong matches back on and tell Claude and the user. No model call.
 */
export function promptSubmit(root: string, prompt: string): PromptSubmitOutput {
  const cfg = loadConfig();
  if (!cfg.auto || !prompt.trim()) return {};
  const t = loadTriggers();
  if (!t) return {};
  const candidates = offCandidates(root);
  if (!candidates.length) return {};
  const matches = scorePrompt(prompt, candidates, t, cfg.threshold ?? DEFAULT_THRESHOLD).slice(0, MAX_AUTO);
  const context: string[] = [];
  const notes: string[] = [];
  for (const mt of matches) {
    const lines: string[] = [];
    const words = mt.words.map((w) => `"${w}"`).join(', ');
    if (on(root, mt.id, { reason: `auto: prompt mentions ${words}` }, (s) => lines.push(s)) !== 0) continue;
    context.push(`ctx switched ${mt.id} back on because the prompt mentions ${words}.`, ...lines);
    notes.push(`${shortId(mt.id)}${mt.id.startsWith('plugin:') ? ' (run /reload-plugins to load it now)' : ''}`);
  }
  if (!context.length) return {};
  return {
    systemMessage: `ctx: switched on ${notes.join(', ')} for this prompt. /ctx:auto off disables this.`,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context.join('\n') },
  };
}
