import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './paths.js';

export interface ClaudeBinary { path: string; version: string; source: string; }

function tryVersion(bin: string): string | undefined {
  try {
    const r = spawnSync(bin, ['--version'], {
      shell: false, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    if (r.status !== 0) return undefined;
    return r.stdout.match(/(\d+\.\d+\.\d+)/)?.[1];
  } catch {
    return undefined;
  }
}

function newestVsCodeBinary(exe: string): string[] {
  const roots = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].map((d) => path.join(homeDir(), d, 'extensions'));
  const found: { p: string; v: number[] }[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const e of entries) {
      const m = e.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
      if (!m) continue;
      const p = path.join(root, e, 'resources', 'native-binary', exe);
      if (fs.existsSync(p)) found.push({ p, v: [Number(m[1]), Number(m[2]), Number(m[3])] });
    }
  }
  found.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return found.map((f) => f.p);
}

/** Candidate binaries in discovery order (spec §6.1, with VERIFY.md item 14). */
export function candidates(): { path: string; source: string }[] {
  const win = process.platform === 'win32';
  const out: { path: string; source: string }[] = [];
  if (process.env.CTX_CLAUDE_BIN) out.push({ path: process.env.CTX_CLAUDE_BIN, source: 'CTX_CLAUDE_BIN' });
  if (process.env.CLAUDE_CODE_EXECPATH) out.push({ path: process.env.CLAUDE_CODE_EXECPATH, source: 'CLAUDE_CODE_EXECPATH' });
  // PATH lookup without a shell: check each PATH entry ourselves.
  const exts = win ? ['.exe', '.cmd'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, `claude${ext}`);
      if (fs.existsSync(p)) out.push({ path: p, source: 'PATH' });
    }
  }
  const h = homeDir();
  if (win) {
    out.push({ path: path.join(h, '.local', 'bin', 'claude.exe'), source: 'install' });
    if (process.env.APPDATA) out.push({ path: path.join(process.env.APPDATA, 'npm', 'claude.cmd'), source: 'npm' });
    for (const p of newestVsCodeBinary('claude.exe')) out.push({ path: p, source: 'vscode-extension' });
  } else {
    out.push({ path: path.join(h, '.local', 'bin', 'claude'), source: 'install' });
    out.push({ path: path.join(h, '.claude', 'local', 'claude'), source: 'install' });
    for (const p of newestVsCodeBinary('claude')) out.push({ path: p, source: 'vscode-extension' });
  }
  return out;
}

let cached: ClaudeBinary | null | undefined;

export function findClaude(): ClaudeBinary | null {
  if (cached !== undefined) return cached;
  const seen = new Set<string>();
  for (const c of candidates()) {
    const key = c.path.toLowerCase();
    if (seen.has(key) || !fs.existsSync(c.path)) continue;
    seen.add(key);
    // .cmd shims can't be spawned without a shell; skip them (the native binary is preferred anyway).
    if (c.path.toLowerCase().endsWith('.cmd')) continue;
    const version = tryVersion(c.path);
    if (version) return (cached = { path: c.path, version, source: c.source });
  }
  return (cached = null);
}
