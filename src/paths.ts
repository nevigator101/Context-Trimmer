import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function homeDir(): string {
  return process.env.CTX_TEST_HOME ?? os.homedir();
}

/** ~/.claude (or CLAUDE_CONFIG_DIR). */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homeDir(), '.claude');
}

/** ~/.claude.json lives next to ~/.claude unless CLAUDE_CONFIG_DIR is set. */
export function claudeJsonPath(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(homeDir(), '.claude.json');
}

/** ctx state root: ~/.claude/ctx (override with CTX_HOME). */
export function ctxHome(): string {
  return process.env.CTX_HOME ?? path.join(claudeDir(), 'ctx');
}

/** The project root: --project flag, CLAUDE_PROJECT_DIR, or cwd. */
export function resolveProjectRoot(flag?: string): string {
  return path.resolve(flag ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
}

/**
 * Canonical key for a project path: forward slashes, lower-case drive letter, no trailing slash.
 * Matches the keys Claude Code uses in ~/.claude.json "projects" (e.g. "c:/Users/Nev/Observibility Proxy").
 */
export function projectKey(root: string): string {
  let p = path.resolve(root).replace(/\\/g, '/');
  p = p.replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`);
  if (p.length > 3) p = p.replace(/\/+$/, '');
  return p;
}

export function projectHash(root: string): string {
  return createHash('sha256').update(projectKey(root).toLowerCase()).digest('hex').slice(0, 16);
}

export function projectStateDir(root: string): string {
  return path.join(ctxHome(), 'projects', projectHash(root));
}

/** Claude Code's transcript directory slug: every non-alphanumeric character becomes "-". */
export function transcriptSlug(root: string): string {
  return path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');
}

/** All transcript directories for a project (slug matched case-insensitively). */
export function transcriptDirs(root: string): string[] {
  const base = path.join(claudeDir(), 'projects');
  const want = transcriptSlug(root).toLowerCase();
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.toLowerCase() === want)
      .map((d) => path.join(base, d.name));
  } catch {
    return [];
  }
}

export function readJson<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Plain (non-atomic) JSON write for ctx's own state files. */
export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
