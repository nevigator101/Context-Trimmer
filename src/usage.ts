import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { claudeJsonPath, projectKey, projectStateDir, readJson, transcriptDirs, writeJson } from './paths.js';

export interface UsageItem { sessionsUsed: number; calls: number; lastUsedAt?: string; }

export interface Ledger {
  project: string;
  builtAt: string;
  sessionsScanned: number;
  window: { sessions: number };
  sessions: { id: string; file: string; mtime: string; calls: number }[];
  items: Record<string, UsageItem>;
  /** Re-enables recorded by `ctx on` (spec §9.2): item id -> ISO timestamps. */
  reenables: Record<string, string[]>;
  global: {
    skillUsage: Record<string, { usageCount?: number; lastUsedAt?: number }>;
    pluginUsage: Record<string, { usageCount?: number; lastUsedAt?: number }>;
  };
}

/** claude.ai-synced skills are invoked as "anthropic-skills:<name>" but listed and overridden as "<name>". */
export function normalizeSkillName(name: string): string {
  return name.replace(/^anthropic-skills:/, '');
}

/** Map one tool_use block to the item ids it counts as. */
export function itemsForToolUse(name: string, input: Record<string, unknown> | undefined): string[] {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return parts.length >= 3 && parts[1] ? [`mcp:${parts[1]}`] : [];
  }
  const out = [`tool:${name}`];
  if (name === 'Skill' && typeof input?.skill === 'string') out.push(`skill:${normalizeSkillName(input.skill)}`);
  if (name === 'Agent' && typeof input?.subagent_type === 'string') out.push(`agent:${input.subagent_type}`);
  return out;
}

const COMMAND_RE = /<command-name>\/?([^<\s]+)<\/command-name>/g;

interface SessionScan { calls: Map<string, { n: number; last?: string }>; assistantTurns: number; }

async function scanFile(file: string, into: SessionScan): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const bump = (id: string, ts?: string) => {
    const c = into.calls.get(id) ?? { n: 0 };
    c.n++;
    if (ts && (!c.last || ts > c.last)) c.last = ts;
    into.calls.set(id, c);
  };
  for await (const line of rl) {
    // Cheap prefilter: only assistant tool_use lines and user command lines matter.
    if (!line.includes('"assistant"') && !line.includes('command-name')) continue;
    let j: { type?: string; timestamp?: string; message?: { content?: unknown } };
    try { j = JSON.parse(line); } catch { continue; }
    const ts = typeof j.timestamp === 'string' ? j.timestamp : undefined;
    const content = j.message?.content;
    if (j.type === 'assistant') {
      into.assistantTurns++;
      if (!Array.isArray(content)) continue;
      for (const c of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
        if (c?.type === 'tool_use' && typeof c.name === 'string') for (const id of itemsForToolUse(c.name, c.input)) bump(id, ts);
      }
    } else if (j.type === 'user') {
      const texts = typeof content === 'string' ? [content]
        : Array.isArray(content) ? (content as { type?: string; text?: string }[]).filter((c) => c?.type === 'text').map((c) => c.text ?? '') : [];
      for (const t of texts) for (const m of t.matchAll(COMMAND_RE)) bump(`skill:${normalizeSkillName(m[1])}`, ts);
    }
  }
}

export interface UsageOptions { sessions?: number; }

export async function buildLedger(root: string, opts: UsageOptions = {}): Promise<Ledger> {
  const window = opts.sessions ?? 10;
  const files: { file: string; id: string; mtime: number; dir: string }[] = [];
  for (const dir of transcriptDirs(root)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      try { files.push({ file: full, id: f.slice(0, -6), mtime: fs.statSync(full).mtimeMs, dir }); } catch { /* vanished */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const prev = loadLedger(root);
  const ledger: Ledger = {
    project: projectKey(root),
    builtAt: new Date().toISOString(),
    sessionsScanned: 0,
    window: { sessions: window },
    sessions: [],
    items: {},
    reenables: prev?.reenables ?? {},
    global: readGlobalCounters(),
  };

  for (const f of files) {
    if (ledger.sessions.length >= window) break;
    ledger.sessionsScanned++;
    const scan: SessionScan = { calls: new Map(), assistantTurns: 0 };
    await scanFile(f.file, scan);
    // Exclude sessions without an assistant turn, e.g. headless /context measurement runs (VERIFY.md item 2).
    if (scan.assistantTurns === 0) continue;
    const subDir = path.join(f.dir, f.id, 'subagents');
    try {
      for (const s of fs.readdirSync(subDir)) if (s.endsWith('.jsonl')) await scanFile(path.join(subDir, s), scan);
    } catch { /* no subagents */ }
    let calls = 0;
    for (const [id, c] of scan.calls) {
      const it = (ledger.items[id] ??= { sessionsUsed: 0, calls: 0 });
      it.sessionsUsed++;
      it.calls += c.n;
      if (id.startsWith('tool:') || id.startsWith('mcp:')) calls += c.n;
      if (c.last && (!it.lastUsedAt || c.last > it.lastUsedAt)) it.lastUsedAt = c.last;
    }
    ledger.sessions.push({ id: f.id, file: f.file, mtime: new Date(f.mtime).toISOString(), calls });
  }
  writeJson(ledgerPath(root), ledger);
  return ledger;
}

export function readGlobalCounters(): Ledger['global'] {
  const j = readJson<{ skillUsage?: Ledger['global']['skillUsage']; pluginUsage?: Ledger['global']['pluginUsage'] }>(claudeJsonPath());
  return { skillUsage: j?.skillUsage ?? {}, pluginUsage: j?.pluginUsage ?? {} };
}

export function ledgerPath(root: string): string {
  return path.join(projectStateDir(root), 'ledger.json');
}

export function loadLedger(root: string): Ledger | undefined {
  return readJson<Ledger>(ledgerPath(root));
}

/** Global skill usage count, accepting both "docs" and "anthropic-skills:docs" keys. */
export function globalSkillCount(l: Ledger, skill: string): number {
  const g = l.global.skillUsage;
  return (g[skill]?.usageCount ?? 0) + (g[`anthropic-skills:${skill}`]?.usageCount ?? 0);
}
