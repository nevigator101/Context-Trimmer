// Settings writer (spec §8). Merge-only edits of <project>/.claude/settings.local.json with an ownership record,
// a backup before every write, atomic replace, validation with auto-restore, and byte-for-byte undo.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { projectStateDir, readJson, writeJson } from './paths.js';
import { localSettingsPath, type Json } from './settings.js';

/** Entries ctx manages. Values mirror the JSON written. */
export interface Entries {
  deny: string[];
  plugins: Record<string, boolean>;
  skills: Record<string, string>;
  mcpjson: string[];
}

export interface Applied {
  version: 1;
  file: string;
  /** Entries ctx wrote and may remove. */
  owned: Entries;
  /** Entries that were already present when ctx wanted them; never removed by ctx. */
  preexisting: Entries;
  originalBackup?: string;
  /** Entries switched off with `ctx off`; `apply` keeps them even when the plan doesn't list them. */
  pinnedOff?: string[];
  /** sha256 of the bytes ctx last wrote, to detect manual edits. */
  lastWrittenHash?: string;
  history: { at: string; action: string; backup: string; summary: string }[];
  verified?: { at: string; beforeTokens: number; afterTokens: number; rawAfterTokens: number };
}

export const emptyEntries = (): Entries => ({ deny: [], plugins: {}, skills: {}, mcpjson: [] });

export function emptyApplied(file: string): Applied {
  return { version: 1, file, owned: emptyEntries(), preexisting: emptyEntries(), history: [] };
}

const KEEP_BACKUPS = 20;

export function appliedPath(root: string): string { return path.join(projectStateDir(root), 'applied.json'); }
export function backupDir(root: string): string { return path.join(projectStateDir(root), 'backups'); }

export function loadApplied(root: string): Applied {
  return readJson<Applied>(appliedPath(root)) ?? emptyApplied(localSettingsPath(root));
}

/** File-system operations, injectable so tests can simulate failures. */
export interface FsOps { renameSync: typeof fs.renameSync; }
const realOps: FsOps = { renameSync: fs.renameSync };

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sha(b: Buffer | string): string { return createHash('sha256').update(b).digest('hex'); }

/** Format of an existing JSON file, so ctx's writes keep the user's style. */
interface Style { indent: string | number; eol: string; finalNewline: boolean; }
function detectStyle(raw: string | undefined): Style {
  if (!raw) return { indent: 2, eol: '\n', finalNewline: true };
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const m = raw.match(/\n([ \t]+)\S/);
  const indent = m ? (m[1].startsWith('\t') ? '\t' : m[1].length) : 2;
  return { indent, eol, finalNewline: /\r?\n$/.test(raw) };
}
function serialize(obj: Json, style: Style): string {
  let s = JSON.stringify(obj, null, style.indent);
  if (style.eol === '\r\n') s = s.replace(/\n/g, '\r\n');
  return style.finalNewline ? s + style.eol : s;
}

/** Atomic replace: write tmp, fsync, rename (retry 5x with 100 ms backoff for Windows locks). */
export function atomicWrite(file: string, data: string | Buffer, ops: FsOps = realOps): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      ops.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (i < 5) sleepSync(100);
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  throw new Error(`could not replace ${file}: ${(lastErr as Error)?.message ?? lastErr}`);
}

function newBackupId(dir: string): string {
  let id = new Date().toISOString().replace(/[:.]/g, '-');
  let n = 0;
  while (fs.existsSync(path.join(dir, `${id}.state.json`))) id = `${id.replace(/_\d+$/, '')}_${++n}`;
  return id;
}

/** Save the current settings bytes (or "absent") and the current applied.json. Returns the backup id. */
export function backup(root: string): string {
  const dir = backupDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const id = newBackupId(dir);
  const file = localSettingsPath(root);
  const exists = fs.existsSync(file);
  if (exists) fs.copyFileSync(file, path.join(dir, `${id}.settings.local.json`));
  const applied = readJson<Applied>(appliedPath(root));
  fs.writeFileSync(path.join(dir, `${id}.state.json`), JSON.stringify({ settingsExisted: exists, applied: applied ?? null }));
  return id;
}

export function listBackups(root: string): string[] {
  try {
    return fs.readdirSync(backupDir(root)).filter((f) => f.endsWith('.state.json')).map((f) => f.slice(0, -'.state.json'.length)).sort();
  } catch {
    return [];
  }
}

function pruneBackups(root: string, keep: string | undefined): void {
  const all = listBackups(root).filter((b) => b !== keep);
  for (const id of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) removeBackup(root, id);
}

function removeBackup(root: string, id: string): void {
  for (const suffix of ['.settings.local.json', '.state.json']) {
    try { fs.unlinkSync(path.join(backupDir(root), id + suffix)); } catch { /* absent */ }
  }
}

/** Restore one backup byte for byte (settings file and applied.json). */
function restoreBackup(root: string, id: string, ops: FsOps = realOps): void {
  const dir = backupDir(root);
  const st = JSON.parse(fs.readFileSync(path.join(dir, `${id}.state.json`), 'utf8')) as { settingsExisted: boolean; applied: Applied | null };
  const file = localSettingsPath(root);
  if (st.settingsExisted) atomicWrite(file, fs.readFileSync(path.join(dir, `${id}.settings.local.json`)), ops);
  else if (fs.existsSync(file)) fs.unlinkSync(file);
  if (st.applied) writeJson(appliedPath(root), st.applied);
  else try { fs.unlinkSync(appliedPath(root)); } catch { /* absent */ }
}

export type Mutation = (settings: Json, applied: Applied) => string[];

export interface WriteResult { backup: string; changes: string[]; file: string; }

/**
 * Read, back up, mutate, write atomically, validate, record ownership.
 * The mutation edits `settings` in place and `applied` (ownership) and returns change descriptions.
 */
export function writeSettings(root: string, action: string, mutate: Mutation, ops: FsOps = realOps): WriteResult {
  const file = localSettingsPath(root);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  let settings: Json = {};
  if (raw !== undefined && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      settings = parsed as Json;
    } catch (e) {
      throw new Error(`${file} is not valid JSON (${(e as Error).message}); ctx won't overwrite it. Fix it first.`);
    }
  }
  const applied = loadApplied(root);
  const id = backup(root);
  if (!applied.originalBackup) applied.originalBackup = id;

  const changes = mutate(settings, applied);
  if (!changes.length) {
    removeBackup(root, id);
    if (applied.originalBackup === id) delete applied.originalBackup;
    return { backup: '', changes, file };
  }

  const text = serialize(settings, detectStyle(raw));
  try {
    atomicWrite(file, text, ops);
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    try { restoreBackup(root, id); } catch { /* best effort */ }
    throw new Error(`write failed, original restored: ${(e as Error).message}`);
  }
  applied.lastWrittenHash = sha(text);
  applied.history.push({ at: new Date().toISOString(), action, backup: id, summary: changes.join('; ').slice(0, 500) });
  writeJson(appliedPath(root), applied);
  pruneBackups(root, applied.originalBackup);
  return { backup: id, changes, file };
}

export interface UndoResult { restored: string; manualEditsSaved?: string; deleted?: boolean; }

/** True if the settings file differs from what ctx last wrote (user or Claude Code edited it since). */
export function editedSinceWrite(root: string, applied: Applied): boolean {
  const file = localSettingsPath(root);
  if (!applied.lastWrittenHash) return false;
  if (!fs.existsSync(file)) return true;
  return sha(fs.readFileSync(file, 'utf8')) !== applied.lastWrittenHash;
}

/** `ctx undo`: restore the most recent backup. `ctx undo all`: restore the original. */
export function undo(root: string, all = false, ops: FsOps = realOps): UndoResult {
  const applied = loadApplied(root);
  const backups = listBackups(root);
  if (!backups.length) throw new Error('nothing to undo: ctx has no backups for this project');
  const target = all ? (applied.originalBackup ?? backups[0]) : backups[backups.length - 1];
  // Keep whatever is there now, in case it holds manual edits made after ctx's last write.
  let manual: string | undefined;
  if (editedSinceWrite(root, applied)) {
    const dir = backupDir(root);
    manual = `${new Date().toISOString().replace(/[:.]/g, '-')}.pre-undo.settings.local.json`;
    const file = localSettingsPath(root);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, manual));
  }
  restoreBackup(root, target, ops);
  const st = JSON.parse(fs.readFileSync(path.join(backupDir(root), `${target}.state.json`), 'utf8')) as { settingsExisted: boolean };
  // Drop the restored backup and everything after it from the undo chain (the original is kept for "undo all").
  const original = applied.originalBackup;
  for (const b of backups.filter((b) => b >= target)) if (b !== original) removeBackup(root, b);
  // Stamp the restored state so a following undo doesn't see these bytes as manual edits.
  const after = loadApplied(root);
  const file = localSettingsPath(root);
  after.lastWrittenHash = fs.existsSync(file) ? sha(fs.readFileSync(file, 'utf8')) : undefined;
  after.originalBackup = original;
  if (all) { after.owned = emptyEntries(); after.preexisting = emptyEntries(); delete after.verified; }
  after.history = [...applied.history, { at: new Date().toISOString(), action: all ? 'undo all' : 'undo', backup: target, summary: `restored ${target}` }];
  writeJson(appliedPath(root), after);
  return { restored: target, manualEditsSaved: manual, deleted: !st.settingsExisted };
}

// ---- entry helpers used by mutations ----

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function denyList(s: Json, create: boolean): unknown[] | undefined {
  if (!isObj(s.permissions)) { if (!create) return undefined; s.permissions = {}; }
  const p = s.permissions as Json;
  if (!Array.isArray(p.deny)) { if (!create) return undefined; p.deny = []; }
  return p.deny as unknown[];
}
function objKey(s: Json, key: string, create: boolean): Json | undefined {
  if (!isObj(s[key])) { if (!create) return undefined; s[key] = {}; }
  return s[key] as Json;
}
function cleanupEmpty(s: Json): void {
  if (isObj(s.permissions)) {
    if (Array.isArray(s.permissions.deny) && !s.permissions.deny.length) delete s.permissions.deny;
    if (!Object.keys(s.permissions).length) delete s.permissions;
  }
  for (const k of ['enabledPlugins', 'skillOverrides']) if (isObj(s[k]) && !Object.keys(s[k] as Json).length) delete s[k];
  if (Array.isArray(s.disabledMcpjsonServers) && !s.disabledMcpjsonServers.length) delete s.disabledMcpjsonServers;
}

export type EntryRef =
  | { kind: 'tool'; name: string }
  | { kind: 'plugin'; id: string }
  | { kind: 'skill'; name: string; level: 'name-only' | 'user-invocable-only' | 'off' }
  | { kind: 'mcpjson'; name: string };

export function describeRef(r: EntryRef): string {
  if (r.kind === 'tool') return `deny ${r.name}`;
  if (r.kind === 'plugin') return `plugin ${r.id} off`;
  if (r.kind === 'skill') return `skill ${r.name} ${r.level}`;
  return `.mcp.json server ${r.name} off`;
}

/** Set one trim entry. Owned if ctx adds it; preexisting if already there; skipped if the user set a different value. */
export function setEntry(s: Json, a: Applied, r: EntryRef): string | undefined {
  if (r.kind === 'tool') {
    const deny = denyList(s, true)!;
    if (deny.includes(r.name)) {
      if (!a.owned.deny.includes(r.name) && !a.preexisting.deny.includes(r.name)) a.preexisting.deny.push(r.name);
      return undefined;
    }
    deny.push(r.name);
    a.owned.deny.push(r.name);
    return describeRef(r);
  }
  if (r.kind === 'plugin') {
    const ep = objKey(s, 'enabledPlugins', true)!;
    if (ep[r.id] === false) {
      if (!(r.id in a.owned.plugins)) a.preexisting.plugins[r.id] = false;
      return undefined;
    }
    if (r.id in ep && !(r.id in a.owned.plugins)) return `skipped plugin ${r.id}: set to ${String(ep[r.id])} by you`;
    ep[r.id] = false;
    a.owned.plugins[r.id] = false;
    return describeRef(r);
  }
  if (r.kind === 'skill') {
    const so = objKey(s, 'skillOverrides', true)!;
    if (so[r.name] === r.level) {
      if (!(r.name in a.owned.skills)) a.preexisting.skills[r.name] = r.level;
      return undefined;
    }
    if (r.name in so && !(r.name in a.owned.skills)) return `skipped skill ${r.name}: set to "${String(so[r.name])}" by you`;
    so[r.name] = r.level;
    a.owned.skills[r.name] = r.level;
    return describeRef(r);
  }
  if (!Array.isArray(s.disabledMcpjsonServers)) s.disabledMcpjsonServers = [];
  const list = s.disabledMcpjsonServers as unknown[];
  if (list.includes(r.name)) {
    if (!a.owned.mcpjson.includes(r.name)) a.preexisting.mcpjson.push(r.name);
    return undefined;
  }
  list.push(r.name);
  a.owned.mcpjson.push(r.name);
  return describeRef(r);
}

export type ClearResult = 'removed' | 'not-owned' | 'absent';

/** Remove one trim entry. Only entries ctx owns are removed unless `force` (then any entry in this local file). */
export function clearEntry(s: Json, a: Applied, r: EntryRef, force = false): ClearResult {
  const drop = <T>(arr: T[], v: T) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };
  let result: ClearResult = 'absent';
  if (r.kind === 'tool') {
    const deny = denyList(s, false);
    if (deny?.includes(r.name)) {
      if (a.owned.deny.includes(r.name) || force) { drop(deny, r.name); drop(a.owned.deny, r.name); drop(a.preexisting.deny, r.name); result = 'removed'; }
      else result = 'not-owned';
    }
  } else if (r.kind === 'plugin') {
    const ep = objKey(s, 'enabledPlugins', false);
    if (ep && ep[r.id] === false) {
      if (r.id in a.owned.plugins || force) { delete ep[r.id]; delete a.owned.plugins[r.id]; delete a.preexisting.plugins[r.id]; result = 'removed'; }
      else result = 'not-owned';
    }
  } else if (r.kind === 'skill') {
    const so = objKey(s, 'skillOverrides', false);
    if (so && r.name in so && so[r.name] !== 'on') {
      if (r.name in a.owned.skills || force) { delete so[r.name]; delete a.owned.skills[r.name]; delete a.preexisting.skills[r.name]; result = 'removed'; }
      else result = 'not-owned';
    }
  } else {
    const list = Array.isArray(s.disabledMcpjsonServers) ? s.disabledMcpjsonServers as unknown[] : undefined;
    if (list?.includes(r.name)) {
      if (a.owned.mcpjson.includes(r.name) || force) { drop(list, r.name); drop(a.owned.mcpjson, r.name); result = 'removed'; }
      else result = 'not-owned';
    }
  }
  cleanupEmpty(s);
  return result;
}

/** Entry refs for everything ctx owns. */
export function ownedRefs(a: Applied): EntryRef[] {
  return [
    ...a.owned.deny.map((name) => ({ kind: 'tool', name }) as EntryRef),
    ...Object.keys(a.owned.plugins).map((id) => ({ kind: 'plugin', id }) as EntryRef),
    ...Object.entries(a.owned.skills).map(([name, level]) => ({ kind: 'skill', name, level }) as EntryRef),
    ...a.owned.mcpjson.map((name) => ({ kind: 'mcpjson', name }) as EntryRef),
  ];
}

export function refKey(r: EntryRef): string {
  return r.kind === 'plugin' ? `plugin:${r.id}` : r.kind === 'mcpjson' ? `mcpjson:${r.name}` : `${r.kind}:${r.name}`;
}

/** Owned entries that are no longer in the file as ctx wrote them (manual edits). */
export function driftedEntries(settings: Json, a: Applied): string[] {
  const out: string[] = [];
  const deny = (isObj(settings.permissions) && Array.isArray(settings.permissions.deny)) ? settings.permissions.deny : [];
  for (const t of a.owned.deny) if (!deny.includes(t)) out.push(`tool:${t}`);
  const ep = isObj(settings.enabledPlugins) ? settings.enabledPlugins : {};
  for (const p of Object.keys(a.owned.plugins)) if (ep[p] !== false) out.push(`plugin:${p}`);
  const so = isObj(settings.skillOverrides) ? settings.skillOverrides : {};
  for (const [k, v] of Object.entries(a.owned.skills)) if (so[k] !== v) out.push(`skill:${k}`);
  return out;
}
