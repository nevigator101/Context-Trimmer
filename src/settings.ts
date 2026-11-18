import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, readJson } from './paths.js';

export type Json = Record<string, unknown>;
export type Scope = 'managed' | 'user' | 'project' | 'local';

export interface SettingsFile { scope: Scope; path: string; exists: boolean; data?: Json; error?: string; }

export function managedSettingsPath(): string {
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

export function localSettingsPath(root: string): string {
  return path.join(root, '.claude', 'settings.local.json');
}

function load(scope: Scope, file: string): SettingsFile {
  if (!fs.existsSync(file)) return { scope, path: file, exists: false };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { scope, path: file, exists: true, error: 'not a JSON object' };
    return { scope, path: file, exists: true, data: data as Json };
  } catch (e) {
    return { scope, path: file, exists: true, error: (e as Error).message };
  }
}

/** All settings scopes, lowest precedence first (user < project < local; managed is separate and wins). */
export function loadScopes(root: string): SettingsFile[] {
  return [
    load('user', path.join(claudeDir(), 'settings.json')),
    load('project', path.join(root, '.claude', 'settings.json')),
    load('local', localSettingsPath(root)),
    load('managed', managedSettingsPath()),
  ];
}

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** True if a permissions.deny rule is a bare tool name (removes the tool from context). */
export function isBareToolRule(rule: unknown): rule is string {
  return typeof rule === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(rule) && !rule.startsWith('mcp__');
}

/** Settings keys that trim context. Removing them yields the "untrimmed" reference config. */
export function stripTrimKeys(data: Json | undefined): Json {
  const out: Json = JSON.parse(JSON.stringify(data ?? {})) as Json;
  if (isObj(out.permissions) && Array.isArray(out.permissions.deny)) {
    out.permissions.deny = out.permissions.deny.filter((r) => !isBareToolRule(r));
    if (!(out.permissions.deny as unknown[]).length) delete out.permissions.deny;
    if (!Object.keys(out.permissions).length) delete out.permissions;
  }
  if (isObj(out.enabledPlugins)) {
    for (const [k, v] of Object.entries(out.enabledPlugins)) if (v === false) delete out.enabledPlugins[k];
    if (!Object.keys(out.enabledPlugins).length) delete out.enabledPlugins;
  }
  // Keep "on" overrides: they undo a user-level trim (ctx global) and belong to the untrimmed project config.
  if (isObj(out.skillOverrides)) {
    for (const [k, v] of Object.entries(out.skillOverrides)) if (v !== 'on') delete out.skillOverrides[k];
    if (!Object.keys(out.skillOverrides).length) delete out.skillOverrides;
  }
  delete out.disabledMcpjsonServers;
  return out;
}

/**
 * Effective enabledPlugins map across user < project < local.
 * `skipLocal`: the untrimmed reference config, where local `false` trims are ignored but local `true` keep-on
 * overrides still apply (stripTrimKeys keeps them).
 */
export function effectivePlugins(scopes: SettingsFile[], opts: { skipLocal?: boolean } = {}): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const s of scopes) {
    if (s.scope === 'managed') continue;
    const ep = s.data?.enabledPlugins;
    if (isObj(ep)) {
      for (const [k, v] of Object.entries(ep)) {
        if (typeof v !== 'boolean' || (opts.skipLocal && s.scope === 'local' && !v)) continue;
        out[k] = v;
      }
    }
  }
  return out;
}

/** Plugins installed for this project: user-scope installs plus project-scope installs for this path. */
export function installedPlugins(root: string): string[] {
  const j = readJson<{ plugins?: Record<string, { scope?: string; projectPath?: string }[]> }>(
    path.join(claudeDir(), 'plugins', 'installed_plugins.json'));
  const out: string[] = [];
  const norm = (p: string) => path.resolve(p).toLowerCase();
  for (const [id, installs] of Object.entries(j?.plugins ?? {})) {
    if (installs.some((i) => i.scope === 'user' || (i.projectPath && norm(i.projectPath) === norm(root)))) out.push(id);
  }
  return out;
}

/** Plugin id -> description from its plugin.json (installed copy). */
export function pluginDescriptions(): Record<string, string> {
  const j = readJson<{ plugins?: Record<string, { installPath?: string }[]> }>(
    path.join(claudeDir(), 'plugins', 'installed_plugins.json'));
  const out: Record<string, string> = {};
  for (const [id, installs] of Object.entries(j?.plugins ?? {})) {
    for (const i of installs) {
      if (!i.installPath) continue;
      const pj = readJson<{ description?: string }>(path.join(i.installPath, '.claude-plugin', 'plugin.json'));
      if (pj?.description) { out[id] = pj.description; break; }
    }
  }
  return out;
}

/** Where a given trim rule lives, for "it's set in another scope" messages (spec §8.3). */
export function findRule(scopes: SettingsFile[], kind: 'deny' | 'plugin' | 'skill', key: string): SettingsFile[] {
  return scopes.filter((s) => {
    const d = s.data;
    if (!d) return false;
    if (kind === 'deny') return isObj(d.permissions) && Array.isArray(d.permissions.deny) && d.permissions.deny.includes(key);
    if (kind === 'plugin') return isObj(d.enabledPlugins) && d.enabledPlugins[key] === false;
    return isObj(d.skillOverrides) && key in d.skillOverrides;
  });
}
