// Project registry (spec §3.4, §4): the projects ctx has profiled, plus discovery of every project with Claude Code
// transcripts, so `ctx global` can see which project uses which extra.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { claudeDir, ctxHome, projectKey, readJson, transcriptSlug, writeJson } from './paths.js';

export interface RegistryEntry { root: string; firstSeen: string; lastSeen: string; }
export interface Registry { version: 1; projects: Record<string, RegistryEntry>; }

export function registryPath(): string { return path.join(ctxHome(), 'registry.json'); }

export function loadRegistry(): Registry {
  const r = readJson<Registry>(registryPath());
  return r && r.projects ? r : { version: 1, projects: {} };
}

/** Record that ctx profiled (measured, scanned or wrote settings for) a project. Never throws. */
export function registerProject(root: string): void {
  try {
    const reg = loadRegistry();
    const key = projectKey(root);
    const now = new Date().toISOString();
    const cur = reg.projects[key];
    reg.projects[key] = { root: path.resolve(root), firstSeen: cur?.firstSeen ?? now, lastSeen: now };
    writeJson(registryPath(), reg);
  } catch { /* the registry is a convenience; never fail a command over it */ }
}

export interface KnownProject {
  key: string;
  root: string;
  /** Transcript directories (slug matched case-insensitively). */
  dirs: string[];
  /** Newest transcript mtime, ISO. */
  lastActive?: string;
  sessions: number;
  exists: boolean;
  registered: boolean;
}

/** The session cwd from the first lines of a transcript. */
async function cwdOf(file: string): Promise<string | undefined> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (++n > 200) break;
      if (!line.includes('"cwd"')) continue;
      try {
        const j = JSON.parse(line) as { cwd?: unknown };
        if (typeof j.cwd === 'string' && j.cwd) return j.cwd;
      } catch { /* partial line */ }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return undefined;
}

/**
 * Every project with transcripts under ~/.claude/projects, plus registered projects. The project root comes from the
 * transcripts' `cwd` (the folder name is lossy), checked against the folder's slug.
 */
export async function discoverProjects(): Promise<KnownProject[]> {
  const base = path.join(claudeDir(), 'projects');
  const reg = loadRegistry();
  const bySlug = new Map<string, { dirs: string[]; files: { file: string; mtime: number }[] }>();
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { /* no transcripts */ }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const dir = path.join(base, d.name);
    const slot = bySlug.get(d.name.toLowerCase()) ?? { dirs: [], files: [] };
    slot.dirs.push(dir);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        try { slot.files.push({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }); } catch { /* vanished */ }
      }
    } catch { /* unreadable */ }
    bySlug.set(d.name.toLowerCase(), slot);
  }

  const out = new Map<string, KnownProject>();
  // Registered projects first: their roots are known exactly.
  const regBySlug = new Map<string, RegistryEntry>();
  for (const e of Object.values(reg.projects)) regBySlug.set(transcriptSlug(e.root).toLowerCase(), e);

  for (const [slug, slot] of bySlug) {
    if (!slot.files.length) continue;
    slot.files.sort((a, b) => b.mtime - a.mtime);
    let root = regBySlug.get(slug)?.root;
    if (!root) {
      for (const f of slot.files.slice(0, 3)) {
        const cwd = await cwdOf(f.file);
        if (cwd && transcriptSlug(cwd).toLowerCase() === slug) { root = cwd; break; }
      }
    }
    if (!root) continue; // can't map the folder back to a path
    const key = projectKey(root);
    out.set(key, {
      key, root: path.resolve(root), dirs: slot.dirs, lastActive: new Date(slot.files[0].mtime).toISOString(),
      sessions: slot.files.length, exists: fs.existsSync(root), registered: key in reg.projects,
    });
  }
  for (const [key, e] of Object.entries(reg.projects)) {
    if (!out.has(key)) out.set(key, { key, root: e.root, dirs: [], sessions: 0, exists: fs.existsSync(e.root), registered: true });
  }
  return [...out.values()].sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''));
}
