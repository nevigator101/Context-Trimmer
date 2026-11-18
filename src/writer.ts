// Settings writer (spec §8). Merge-only edits of a settings file with an ownership record, a backup before every
// write, atomic replace, validation with auto-restore, and byte-for-byte undo.
// Targets: a project's .claude/settings.local.json (default), or the user's ~/.claude/settings.json (`ctx global`).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, ctxHome, projectStateDir, readJson, writeJson } from './paths.js';
import { localSettingsPath, type Json } from './settings.js';

/** Entries ctx manages. Values mirror the JSON written. */
export interface Entries {
  deny: string[];
  /** false = plugin off; true = keep-on override of an off value in a lower-precedence scope. */
  plugins: Record<string, boolean>;
  /** "name-only" | "user-invocable-only" | "off", or "on" = keep-on override. */
  skills: Record<string, string>;
  mcpjson: string[];
  /** permissions.allow rules, e.g. "Skill(ctx:enable)" so the model can re-enable items without a prompt. */
  allow: string[];
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
  /**
   * Values ctx replaced (refKey -> previous value); clearing the entry restores them. Only `ctx global` replaces:
   * Claude Code writes `enabledPlugins: {"x@m": true}` to user settings on install, so switching x off there must
   * put `true` back on undo.
   */
  replaced?: Record<string, unknown>;
  /** Global target only: keep-on entries written to projects' settings.local.json (project root -> refKeys). */
  projects?: Record<string, string[]>;
  /** Global target only: one-line descriptions of the items switched off, for the capability index. */
  descriptions?: Record<string, string>;
}

export const emptyEntries = (): Entries => ({ deny: [], plugins: {}, skills: {}, mcpjson: [], allow: [] });

export function emptyApplied(file: string): Applied {
  return { version: 1, file, owned: emptyEntries(), preexisting: emptyEntries(), history: [] };
}

const KEEP_BACKUPS = 20;

/** A settings file ctx writes, plus the directory holding its ownership record and backups. */
export interface Target { file: string; stateDir: string; }
/** A project root (meaning its .claude/settings.local.json) or an explicit target. */
export type Where = string | Target;

export function projectTarget(root: string): Target {
  return { file: localSettingsPath(root), stateDir: projectStateDir(root) };
}
/** User-scope settings; written only by `ctx global` (spec §3.4). */
export function globalTarget(): Target {
  return { file: path.join(claudeDir(), 'settings.json'), stateDir: path.join(ctxHome(), 'global') };
}
const T = (w: Where): Target => (typeof w === 'string' ? projectTarget(w) : w);

export function appliedPath(w: Where): string { return path.join(T(w).stateDir, 'applied.json'); }
export function backupDir(w: Where): string { return path.join(T(w).stateDir, 'backups'); }

export function loadApplied(w: Where): Applied {
  const a = readJson<Applied>(appliedPath(w)) ?? emptyApplied(T(w).file);
  // Records written by older versions lack newer entry kinds.
  a.owned = { ...emptyEntries(), ...a.owned };
  a.preexisting = { ...emptyEntries(), ...a.preexisting };
  return a;
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
export function backup(w: Where): string {
  const dir = backupDir(w);
  fs.mkdirSync(dir, { recursive: true });
  const id = newBackupId(dir);
  const file = T(w).file;
  const exists = fs.existsSync(file);
  if (exists) fs.copyFileSync(file, path.join(dir, `${id}.settings.local.json`));
  const applied = readJson<Applied>(appliedPath(w));
  fs.writeFileSync(path.join(dir, `${id}.state.json`), JSON.stringify({ settingsExisted: exists, applied: applied ?? null }));
  return id;
}

export function listBackups(w: Where): string[] {
  try {
    return fs.readdirSync(backupDir(w)).filter((f) => f.endsWith('.state.json')).map((f) => f.slice(0, -'.state.json'.length)).sort();
  } catch {
    return [];
  }
}

function pruneBackups(w: Where, keep: string | undefined): void {
  const all = listBackups(w).filter((b) => b !== keep);
  for (const id of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) removeBackup(w, id);
}

function removeBackup(w: Where, id: string): void {
  for (const suffix of ['.settings.local.json', '.state.json']) {
    try { fs.unlinkSync(path.join(backupDir(w), id + suffix)); } catch { /* absent */ }
  }
}

/** Restore one backup byte for byte (settings file and applied.json). */
function restoreBackup(w: Where, id: string, ops: FsOps = realOps): void {
  const dir = backupDir(w);
  const st = JSON.parse(fs.readFileSync(path.join(dir, `${id}.state.json`), 'utf8')) as { settingsExisted: boolean; applied: Applied | null };
  const file = T(w).file;
  if (st.settingsExisted) atomicWrite(file, fs.readFileSync(path.join(dir, `${id}.settings.local.json`)), ops);
  else if (fs.existsSync(file)) fs.unlinkSync(file);
  if (st.applied) writeJson(appliedPath(w), st.applied);
  else try { fs.unlinkSync(appliedPath(w)); } catch { /* absent */ }
}

/** The bytes of the newest backup whose JSON equals `settings` (same keys, order and values), if any. */
function earlierBytes(w: Where, settings: Json): string | undefined {
  const want = JSON.stringify(settings);
  for (const id of listBackups(w).reverse()) {
    try {
      const text = fs.readFileSync(path.join(backupDir(w), `${id}.settings.local.json`), 'utf8');
      if (JSON.stringify(JSON.parse(text)) === want) return text;
    } catch { /* settings absent in that backup, or unreadable */ }
  }
  return undefined;
}

/** Did the settings file not exist when ctx first wrote it? */
function originallyAbsent(w: Where, originalBackup: string | undefined): boolean {
  if (!originalBackup) return false;
  const st = readJson<{ settingsExisted?: boolean }>(path.join(backupDir(w), `${originalBackup}.state.json`));
  return st?.settingsExisted === false;
}

export type Mutation = (settings: Json, applied: Applied) => string[];

export interface WriteResult { backup: string; changes: string[]; file: string; }

/**
 * Read, back up, mutate, write atomically, validate, record ownership.
 * The mutation edits `settings` in place and `applied` (ownership) and returns change descriptions.
 */
export function writeSettings(w: Where, action: string, mutate: Mutation, ops: FsOps = realOps): WriteResult {
  const file = T(w).file;
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
  const applied = loadApplied(w);
  const id = backup(w);
  if (!applied.originalBackup) applied.originalBackup = id;

  const changes = mutate(settings, applied);
  if (!changes.length) {
    removeBackup(w, id);
    if (applied.originalBackup === id) delete applied.originalBackup;
    return { backup: '', changes, file };
  }

  // Nothing left in a file that didn't exist before ctx: remove it rather than leave "{}" behind.
  if (!Object.keys(settings).length && originallyAbsent(w, applied.originalBackup)) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    delete applied.lastWrittenHash;
  } else {
    // Back to an earlier state (e.g. an override removed again): reuse that state's exact bytes, so formatting the
    // serializer would change (inline arrays, spacing) comes back byte for byte.
    const text = earlierBytes(w, settings) ?? serialize(settings, detectStyle(raw));
    try {
      atomicWrite(file, text, ops);
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      try { restoreBackup(w, id); } catch { /* best effort */ }
      throw new Error(`write failed, original restored: ${(e as Error).message}`);
    }
    applied.lastWrittenHash = sha(text);
  }
  applied.history.push({ at: new Date().toISOString(), action, backup: id, summary: changes.join('; ').slice(0, 500) });
  applied.history = applied.history.slice(-200);
  writeJson(appliedPath(w), applied);
  pruneBackups(w, applied.originalBackup);
  return { backup: id, changes, file };
}

export interface UndoResult { restored: string; manualEditsSaved?: string; deleted?: boolean; }

/** True if the settings file differs from what ctx last wrote (user or Claude Code edited it since). */
export function editedSinceWrite(w: Where, applied: Applied): boolean {
  const file = T(w).file;
  if (!applied.lastWrittenHash) return false;
  if (!fs.existsSync(file)) return true;
  return sha(fs.readFileSync(file, 'utf8')) !== applied.lastWrittenHash;
}

/** `ctx undo`: restore the most recent backup. `ctx undo all`: restore the original. */
export function undo(w: Where, all = false, ops: FsOps = realOps): UndoResult {
  const applied = loadApplied(w);
  const backups = listBackups(w);
  if (!backups.length) throw new Error('nothing to undo: ctx has no backups for this project');
  const target = all ? (applied.originalBackup ?? backups[0]) : backups[backups.length - 1];
  // Keep whatever is there now, in case it holds manual edits made after ctx's last write.
  let manual: string | undefined;
  if (editedSinceWrite(w, applied)) {
    const dir = backupDir(w);
    manual = `${new Date().toISOString().replace(/[:.]/g, '-')}.pre-undo.settings.local.json`;
    const file = T(w).file;
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, manual));
  }
  restoreBackup(w, target, ops);
  const st = JSON.parse(fs.readFileSync(path.join(backupDir(w), `${target}.state.json`), 'utf8')) as { settingsExisted: boolean };
  // Drop the restored backup and everything after it from the undo chain (the original is kept for "undo all").
  const original = applied.originalBackup;
  for (const b of backups.filter((b) => b >= target)) if (b !== original) removeBackup(w, b);
  // Stamp the restored state so a following undo doesn't see these bytes as manual edits.
  const after = loadApplied(w);
  const file = T(w).file;
  after.lastWrittenHash = fs.existsSync(file) ? sha(fs.readFileSync(file, 'utf8')) : undefined;
  after.originalBackup = original;
  if (all) { after.owned = emptyEntries(); after.preexisting = emptyEntries(); delete after.verified; delete after.replaced; }
  after.history = [...applied.history, { at: new Date().toISOString(), action: all ? 'undo all' : 'undo', backup: target, summary: `restored ${target}` }];
  writeJson(appliedPath(w), after);
  return { restored: target, manualEditsSaved: manual, deleted: !st.settingsExisted };
}

// ---- entry helpers used by mutations ----

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function permList(s: Json, key: 'deny' | 'allow', create: boolean): unknown[] | undefined {
  if (!isObj(s.permissions)) { if (!create) return undefined; s.permissions = {}; }
  const p = s.permissions as Json;
  if (!Array.isArray(p[key])) { if (!create) return undefined; p[key] = []; }
  return p[key] as unknown[];
}
const denyList = (s: Json, create: boolean) => permList(s, 'deny', create);
function objKey(s: Json, key: string, create: boolean): Json | undefined {
  if (!isObj(s[key])) { if (!create) return undefined; s[key] = {}; }
  return s[key] as Json;
}
function cleanupEmpty(s: Json): void {
  if (isObj(s.permissions)) {
    if (Array.isArray(s.permissions.deny) && !s.permissions.deny.length) delete s.permissions.deny;
    if (Array.isArray(s.permissions.allow) && !s.permissions.allow.length) delete s.permissions.allow;
    if (!Object.keys(s.permissions).length) delete s.permissions;
  }
  for (const k of ['enabledPlugins', 'skillOverrides']) if (isObj(s[k]) && !Object.keys(s[k] as Json).length) delete s[k];
  if (Array.isArray(s.disabledMcpjsonServers) && !s.disabledMcpjsonServers.length) delete s.disabledMcpjsonServers;
}

export type SkillLevel = 'name-only' | 'user-invocable-only' | 'off' | 'on';

export type EntryRef =
  | { kind: 'tool'; name: string }
  /** value false (default) = off; true = keep-on override. */
  | { kind: 'plugin'; id: string; value?: boolean }
  | { kind: 'skill'; name: string; level: SkillLevel }
  | { kind: 'mcpjson'; name: string }
  | { kind: 'allow'; rule: string };

/** Keep-on overrides (plugin true, skill "on") undo an off value set in a lower-precedence scope. */
export function isKeepOn(r: EntryRef): boolean {
  return (r.kind === 'plugin' && r.value === true) || (r.kind === 'skill' && r.level === 'on');
}

export function describeRef(r: EntryRef): string {
  if (r.kind === 'allow') return `allow ${r.rule}`;
  if (r.kind === 'tool') return `deny ${r.name}`;
  if (r.kind === 'plugin') return r.value ? `plugin ${r.id} on (override)` : `plugin ${r.id} off`;
  if (r.kind === 'skill') return r.level === 'on' ? `skill ${r.name} on (override)` : `skill ${r.name} ${r.level}`;
  return `.mcp.json server ${r.name} off`;
}

export interface SetOptions {
  /**
   * Replace a value the user set (recording it in `replaced` so clearing restores it) instead of skipping.
   * Used only by `ctx global` for `enabledPlugins: true` entries that Claude Code writes on install.
   */
  replace?: (current: unknown) => boolean;
}

/** Set one entry. Owned if ctx adds it; preexisting if already there; skipped if the user set a different value. */
export function setEntry(s: Json, a: Applied, r: EntryRef, opts: SetOptions = {}): string | undefined {
  if (r.kind === 'allow') {
    const allow = permList(s, 'allow', true)!;
    if (allow.includes(r.rule)) {
      if (!a.owned.allow.includes(r.rule) && !a.preexisting.allow.includes(r.rule)) a.preexisting.allow.push(r.rule);
      return undefined;
    }
    allow.push(r.rule);
    a.owned.allow.push(r.rule);
    return describeRef(r);
  }
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
    const v = r.value ?? false;
    const ep = objKey(s, 'enabledPlugins', true)!;
    if (ep[r.id] === v) {
      if (!(r.id in a.owned.plugins)) a.preexisting.plugins[r.id] = v;
      else a.owned.plugins[r.id] = v;
      return undefined;
    }
    if (r.id in ep && !(r.id in a.owned.plugins)) {
      if (!opts.replace?.(ep[r.id])) { cleanupEmpty(s); return `skipped plugin ${r.id}: set to ${String(ep[r.id])} by you`; }
      (a.replaced ??= {})[refKey(r)] = ep[r.id];
      delete a.preexisting.plugins[r.id];
    }
    ep[r.id] = v;
    a.owned.plugins[r.id] = v;
    return describeRef(r);
  }
  if (r.kind === 'skill') {
    const so = objKey(s, 'skillOverrides', true)!;
    if (so[r.name] === r.level) {
      if (!(r.name in a.owned.skills)) a.preexisting.skills[r.name] = r.level;
      else a.owned.skills[r.name] = r.level;
      return undefined;
    }
    if (r.name in so && !(r.name in a.owned.skills)) {
      if (!opts.replace?.(so[r.name])) { cleanupEmpty(s); return `skipped skill ${r.name}: set to "${String(so[r.name])}" by you`; }
      (a.replaced ??= {})[refKey(r)] = so[r.name];
      delete a.preexisting.skills[r.name];
    }
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

/**
 * Remove one entry. Only entries ctx owns are removed unless `force` (then any entry in this file).
 * Plugin refs match by value (false unless `value: true`); skill refs match any trim level, or "on" for keep-on refs.
 * A value ctx replaced is restored instead of deleted.
 */
export function clearEntry(s: Json, a: Applied, r: EntryRef, force = false): ClearResult {
  const drop = <T>(arr: T[], v: T) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };
  const restore = (obj: Json, key: string, rk: string) => {
    if (a.replaced && rk in a.replaced) { obj[key] = a.replaced[rk]; delete a.replaced[rk]; } else delete obj[key];
  };
  let result: ClearResult = 'absent';
  if (r.kind === 'allow') {
    const allow = permList(s, 'allow', false);
    if (allow?.includes(r.rule)) {
      if (a.owned.allow.includes(r.rule) || force) { drop(allow, r.rule); drop(a.owned.allow, r.rule); drop(a.preexisting.allow, r.rule); result = 'removed'; }
      else result = 'not-owned';
    }
  } else if (r.kind === 'tool') {
    const deny = denyList(s, false);
    if (deny?.includes(r.name)) {
      if (a.owned.deny.includes(r.name) || force) { drop(deny, r.name); drop(a.owned.deny, r.name); drop(a.preexisting.deny, r.name); result = 'removed'; }
      else result = 'not-owned';
    }
  } else if (r.kind === 'plugin') {
    const ep = objKey(s, 'enabledPlugins', false);
    const v = r.value ?? false;
    if (ep && ep[r.id] === v) {
      if (a.owned.plugins[r.id] === v || force) {
        restore(ep, r.id, refKey(r)); delete a.owned.plugins[r.id]; delete a.preexisting.plugins[r.id]; result = 'removed';
      } else result = 'not-owned';
    }
  } else if (r.kind === 'skill') {
    const so = objKey(s, 'skillOverrides', false);
    const match = (v: unknown) => (r.level === 'on' ? v === 'on' : v !== undefined && v !== 'on');
    if (so && r.name in so && match(so[r.name])) {
      if ((r.name in a.owned.skills && match(a.owned.skills[r.name])) || force) {
        restore(so, r.name, refKey(r)); delete a.owned.skills[r.name]; delete a.preexisting.skills[r.name]; result = 'removed';
      } else result = 'not-owned';
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
    ...Object.entries(a.owned.plugins).map(([id, value]) => ({ kind: 'plugin', id, ...(value ? { value } : {}) }) as EntryRef),
    ...Object.entries(a.owned.skills).map(([name, level]) => ({ kind: 'skill', name, level }) as EntryRef),
    ...a.owned.mcpjson.map((name) => ({ kind: 'mcpjson', name }) as EntryRef),
    ...a.owned.allow.map((rule) => ({ kind: 'allow', rule }) as EntryRef),
  ];
}

export function refKey(r: EntryRef): string {
  if (r.kind === 'allow') return `allow:${r.rule}`;
  if (r.kind === 'plugin') return r.value ? `plugin-on:${r.id}` : `plugin:${r.id}`;
  if (r.kind === 'skill') return r.level === 'on' ? `skill-on:${r.name}` : `skill:${r.name}`;
  return r.kind === 'mcpjson' ? `mcpjson:${r.name}` : `${r.kind}:${r.name}`;
}

/** Parse a refKey back into a ref (skill trim keys come back at name-only; clearEntry matches any trim level). */
export function refFromKey(k: string): EntryRef | undefined {
  const i = k.indexOf(':');
  const kind = k.slice(0, i);
  const name = k.slice(i + 1);
  if (kind === 'tool') return { kind: 'tool', name };
  if (kind === 'plugin') return { kind: 'plugin', id: name };
  if (kind === 'plugin-on') return { kind: 'plugin', id: name, value: true };
  if (kind === 'skill') return { kind: 'skill', name, level: 'name-only' };
  if (kind === 'skill-on') return { kind: 'skill', name, level: 'on' };
  if (kind === 'mcpjson') return { kind: 'mcpjson', name };
  if (kind === 'allow') return { kind: 'allow', rule: name };
  return undefined;
}

/** Allow rule that lets the model invoke /ctx:enable without a permission prompt. */
export const ENABLE_RULE = 'Skill(ctx:enable)';

/** Owned entries that are no longer in the file as ctx wrote them (manual edits). */
export function driftedEntries(settings: Json, a: Applied): string[] {
  const out: string[] = [];
  const deny = (isObj(settings.permissions) && Array.isArray(settings.permissions.deny)) ? settings.permissions.deny : [];
  for (const t of a.owned.deny) if (!deny.includes(t)) out.push(`tool:${t}`);
  const ep = isObj(settings.enabledPlugins) ? settings.enabledPlugins : {};
  for (const [p, v] of Object.entries(a.owned.plugins)) if (ep[p] !== v) out.push(`plugin:${p}`);
  const so = isObj(settings.skillOverrides) ? settings.skillOverrides : {};
  for (const [k, v] of Object.entries(a.owned.skills)) if (so[k] !== v) out.push(`skill:${k}`);
  return out;
}
