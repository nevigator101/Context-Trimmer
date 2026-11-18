// Learned triggers (spec §9.3). From transcripts, learn which prompt words preceded the use of each tool, plugin or
// skill. The UserPromptSubmit hook scores each prompt locally (no model call) against the items that are switched off
// in the project and switches a strong match back on before Claude sees the prompt. Opt-in: `ctx auto on`.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { claudeDir, ctxHome, readJson, writeJson } from './paths.js';
import type { KnownProject } from './registry.js';
import { itemsForToolUse, normalizeSkillName } from './usage.js';

export interface Keyword { word: string; weight: number; hits: number; source: 'name' | 'learned'; }
export interface Triggers {
  version: 1;
  learnedAt: string;
  sessions: number;
  prompts: number;
  items: Record<string, { prompts: number; keywords: Keyword[] }>;
}

export interface AutoConfig { auto?: boolean; threshold?: number; }

export function configPath(): string { return path.join(ctxHome(), 'config.json'); }
export function loadConfig(): AutoConfig { return readJson<AutoConfig>(configPath()) ?? {}; }
export function saveConfig(c: AutoConfig): void { writeJson(configPath(), c); }
export function triggersPath(): string { return path.join(ctxHome(), 'triggers.json'); }
export function loadTriggers(): Triggers | undefined { return readJson<Triggers>(triggersPath()); }

export const DEFAULT_THRESHOLD = 0.75;

// Words that say nothing about which capability a prompt needs.
const STOP = new Set((
  'the and for with that this from have has had was were are is be been being you your yours our ours they them their '
  + 'what when where which while who whom why how can could would should will shall may might must not but or nor so '
  + 'yet all any each few more most other some such only own same than too very just also into onto over under again '
  + 'then once here there out off about above below between both does did doing done make made use using used get got '
  + 'please thanks thank need want like let lets look see run add fix check now new one two its it\'s i\'m dont don\'t '
  + 'file files code thing things way able sure okay yes no').split(/\s+/));

/** Lower-case words of a prompt: letters, digits and inner hyphens; at least 3 characters; no stop words. */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9-]*[a-z0-9]/g) ?? []) {
    for (const w of [raw, ...(raw.includes('-') ? raw.split('-') : [])]) {
      if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
    }
  }
  return [...out];
}

/** Plugin name -> full id and skill names, from installed_plugins.json and each install's skills/ folder. */
function pluginIndex(): Map<string, { id: string; skills: string[] }> {
  const out = new Map<string, { id: string; skills: string[] }>();
  const inst = readJson<{ plugins?: Record<string, { installPath?: string }[]> }>(path.join(claudeDir(), 'plugins', 'installed_plugins.json'));
  for (const [id, installs] of Object.entries(inst?.plugins ?? {})) {
    const name = id.split('@')[0];
    const skills = new Set<string>();
    for (const i of installs) {
      try { for (const d of fs.readdirSync(path.join(i.installPath ?? '', 'skills'))) skills.add(d.toLowerCase()); } catch { /* none */ }
    }
    out.set(name, { id, skills: [...skills] });
  }
  return out;
}

/** Item ids a tool_use counts as for triggers: tools, non-plugin skills, and plugins (via their skills/agents/MCP). */
export function triggerItems(name: string, input: Record<string, unknown> | undefined, plugins: Map<string, { id: string }>): string[] {
  const out = new Set<string>();
  for (const id of itemsForToolUse(name, input)) {
    if (id.startsWith('tool:')) out.add(id);
    else if (id.startsWith('skill:') || id.startsWith('agent:')) {
      const rest = id.slice(id.indexOf(':') + 1);
      const i = rest.indexOf(':');
      if (i > 0) { const p = plugins.get(rest.slice(0, i)); if (p) out.add(`plugin:${p.id}`); }
      else if (id.startsWith('skill:')) out.add(id);
    } else if (id.startsWith('mcp:plugin_')) {
      const p = [...plugins.keys()].find((n) => id.startsWith(`mcp:plugin_${n}_`));
      if (p) out.add(`plugin:${plugins.get(p)!.id}`);
    }
  }
  return [...out];
}

/** The text a user typed, or undefined for tool results, meta lines and injected context. */
function promptText(j: { type?: string; isMeta?: boolean; message?: { content?: unknown } }): string | undefined {
  if (j.type !== 'user' || j.isMeta) return undefined;
  const c = j.message?.content;
  const texts = typeof c === 'string' ? [c]
    : Array.isArray(c) ? (c as { type?: string; text?: string }[]).filter((b) => b?.type === 'text').map((b) => b.text ?? '') : [];
  if (!texts.length) return undefined;
  let t = texts.join('\n');
  const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (/<command-name>/.test(t)) t = args?.[1] ?? '';
  else if (/^\s*<(local-command|system-reminder|bash-|task-notification)/.test(t)) return undefined;
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  return t.trim() ? t : undefined;
}

interface Counts { prompts: number; df: Map<string, number>; items: Map<string, { prompts: number; words: Map<string, number> }>; }

async function scanSession(file: string, plugins: Map<string, { id: string }>, into: Counts): Promise<void> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let words: string[] | undefined;
  let used = new Set<string>();
  const flush = () => {
    if (!words) return;
    into.prompts++;
    for (const w of words) into.df.set(w, (into.df.get(w) ?? 0) + 1);
    for (const id of used) {
      const it = into.items.get(id) ?? { prompts: 0, words: new Map<string, number>() };
      it.prompts++;
      for (const w of words) it.words.set(w, (it.words.get(w) ?? 0) + 1);
      into.items.set(id, it);
    }
  };
  for await (const line of rl) {
    if (!line.includes('"user"') && !line.includes('"assistant"')) continue;
    let j: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };
    try { j = JSON.parse(line); } catch { continue; }
    if (j.isSidechain) continue;
    if (j.type === 'user') {
      const t = promptText(j);
      if (t === undefined) continue;
      flush();
      words = tokenize(t);
      used = new Set();
    } else if (j.type === 'assistant' && words && Array.isArray(j.message?.content)) {
      for (const c of j.message!.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
        if (c?.type === 'tool_use' && typeof c.name === 'string') for (const id of triggerItems(c.name, c.input, plugins)) used.add(id);
      }
    }
  }
  flush();
}

/** Item names that are everyday words in coding prompts; they never trigger on their own (learned words still can). */
const GENERIC_NAMES = new Set(['loop', 'init', 'docs', 'plan', 'test', 'tests', 'setup', 'report', 'update', 'config',
  'debug', 'review', 'simplify', 'schedule', 'search', 'write', 'read', 'edit', 'task', 'tasks', 'agent', 'agents']);

/** Keywords from an item's own name (and, for plugins, its skill names). Short or generic names are skipped. */
export function nameKeywords(id: string, pluginSkills: string[] = []): string[] {
  const name = id.slice(id.indexOf(':') + 1).split('@')[0].replace(/^anthropic-skills:/, '').toLowerCase();
  const out = new Set<string>();
  const ok = (w: string) => w.length >= 4 && !STOP.has(w) && !GENERIC_NAMES.has(w);
  if (ok(name)) out.add(name);
  // CamelCase tool names: "ScheduleWakeup" -> "schedulewakeup" is useless in prompts; keep distinctive parts.
  if (id.startsWith('tool:')) for (const p of id.slice(5).split(/(?=[A-Z])/)) if (p.length >= 7 && ok(p.toLowerCase())) out.add(p.toLowerCase());
  for (const s of pluginSkills) if (s.length >= 6 && ok(s)) out.add(s);
  return [...out];
}

export interface LearnOptions { sessions?: number; }

/** Scan the newest sessions of every project and save the trigger table. */
export async function learnTriggers(projects: KnownProject[], opts: LearnOptions = {}): Promise<Triggers> {
  const per = opts.sessions ?? 30;
  const plugins = pluginIndex();
  const counts: Counts = { prompts: 0, df: new Map(), items: new Map() };
  let sessions = 0;
  for (const p of projects) {
    const files: { file: string; mtime: number }[] = [];
    for (const d of p.dirs) {
      try {
        for (const f of fs.readdirSync(d)) if (f.endsWith('.jsonl')) files.push({ file: path.join(d, f), mtime: fs.statSync(path.join(d, f)).mtimeMs });
      } catch { /* unreadable */ }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(0, per)) { await scanSession(f.file, plugins, counts); sessions++; }
  }

  const items: Triggers['items'] = {};
  const ids = new Set<string>([...counts.items.keys(), ...[...plugins.values()].map((p) => `plugin:${p.id}`)]);
  for (const id of ids) {
    const it = counts.items.get(id);
    const kws: Keyword[] = [];
    const pskills = id.startsWith('plugin:') ? plugins.get(id.slice(7).split('@')[0])?.skills : undefined;
    for (const w of nameKeywords(id, pskills)) kws.push({ word: w, weight: 1, hits: it?.words.get(w) ?? 0, source: 'name' });
    for (const [w, c] of it?.words ?? []) {
      if (c < 2 || kws.some((k) => k.word === w)) continue;
      const precision = c / (counts.df.get(w) ?? c);
      if (precision < 0.5) continue;
      kws.push({ word: w, weight: Math.round(precision * Math.min(1, c / 3) * 100) / 100, hits: c, source: 'learned' });
    }
    // All name keywords (bounded by the plugin's skill count), then the 10 strongest learned ones.
    const named = kws.filter((k) => k.source === 'name').sort((a, b) => b.hits - a.hits);
    const learned = kws.filter((k) => k.source === 'learned').sort((a, b) => b.weight - a.weight || b.hits - a.hits).slice(0, 10);
    if (kws.length) items[id] = { prompts: it?.prompts ?? 0, keywords: [...named, ...learned] };
  }
  const t: Triggers = { version: 1, learnedAt: new Date().toISOString(), sessions, prompts: counts.prompts, items };
  writeJson(triggersPath(), t);
  return t;
}

export interface Match { id: string; score: number; words: string[]; }

/** Score a prompt against candidate items. Score = best keyword weight plus a little for each further match, max 1. */
export function scorePrompt(prompt: string, candidates: string[], t: Triggers | undefined, threshold = DEFAULT_THRESHOLD): Match[] {
  if (!t) return [];
  const words = new Set(tokenize(prompt));
  const out: Match[] = [];
  for (const id of candidates) {
    const kws = t.items[id]?.keywords ?? [];
    const hit = kws.filter((k) => words.has(k.word)).sort((a, b) => b.weight - a.weight);
    if (!hit.length) continue;
    const score = Math.min(1, hit[0].weight + hit.slice(1).reduce((a, k) => a + k.weight * 0.25, 0));
    if (score >= threshold) out.push({ id, score: Math.round(score * 100) / 100, words: hit.map((k) => k.word) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** For display: the skill-name form ("docx") of an item id. */
export function shortId(id: string): string {
  return normalizeSkillName(id.slice(id.indexOf(':') + 1)).split('@')[0];
}
