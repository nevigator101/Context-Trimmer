// M4: project registry, `ctx global` (plan, apply, undo), keep-on overrides, learned triggers and the
// UserPromptSubmit hook. Everything runs in a temp home: ~/.claude, ctx state and two projects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { on } from '../src/commands.js';
import { applyGlobal, buildGlobalPlan, globalOffHere, projectUses, undoGlobal } from '../src/global.js';
import { capabilityIndex, hardOffEntries, offCandidates, promptSubmit } from '../src/hook.js';
import type { ItemMeasurement, Measurement } from '../src/measure.js';
import { measurementPath } from '../src/measure.js';
import { claudeDir, projectKey, transcriptSlug, writeJson } from '../src/paths.js';
import { discoverProjects, loadRegistry, registerProject } from '../src/registry.js';
import { loadScopes, stripTrimKeys, effectivePlugins } from '../src/settings.js';
import { learnTriggers, nameKeywords, saveConfig, scorePrompt, tokenize } from '../src/triggers.js';
import type { Ledger } from '../src/usage.js';
import { clearEntry, globalTarget, loadApplied, setEntry, writeSettings } from '../src/writer.js';

let home: string;
let A: string; // uses the cloudflare plugin and the watch plugin
let B: string; // uses only the watch plugin
let C: string; // uses the watch plugin and docx
const USER_SETTINGS = JSON.stringify({ model: 'opus', enabledPlugins: { 'cloudflare@cloudflare': true, 'watch@claude-video': true } }, null, 2) + '\n';

const userFile = () => path.join(claudeDir(), 'settings.json');
const localFile = (root: string) => path.join(root, '.claude', 'settings.local.json');
const readJ = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, any>;
const line = (o: unknown) => JSON.stringify(o) + '\n';
const lines: string[] = [];
const out = (s: string) => { lines.push(s); };

function transcript(root: string, id: string, turns: [string, [string, Record<string, unknown>][]][]): void {
  const dir = path.join(claudeDir(), 'projects', transcriptSlug(root));
  fs.mkdirSync(dir, { recursive: true });
  let s = '';
  let n = 0;
  for (const [prompt, uses] of turns) {
    const ts = `2026-11-1${n++ % 9}T10:00:00Z`;
    s += line({ type: 'user', cwd: root, timestamp: ts, message: { role: 'user', content: prompt } });
    s += line({
      type: 'assistant', cwd: root, timestamp: ts,
      message: { role: 'assistant', content: uses.map(([name, input]) => ({ type: 'tool_use', id: 'x', name, input })) },
    });
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), s);
}

const it_ = (kind: ItemMeasurement['kind'], delta: number, extra: Partial<ItemMeasurement> = {}): ItemMeasurement =>
  ({ kind, category: 'x', deltaTokens: delta, method: 'toggle', ...extra });

function measure(root: string, items: Record<string, ItemMeasurement>): void {
  const run = { totalTokens: 20000, correctedTokens: 20000, categories: { Skills: 3000 } };
  const m: Measurement = {
    ccVersion: '2.1.326', binary: 'claude', project: projectKey(root), measuredAt: '2026-11-18T00:00:00Z', fingerprint: 'x',
    reference: run, current: run, skillsQuirk: true, toolDiscovery: 'capture', upfrontTools: [], toolSchemas: {},
    items, skills: [], mcpServers: {}, memoryFiles: [], unparsed: [],
  };
  writeJson(measurementPath(root), m);
  registerProject(root);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-m4-'));
  process.env.CTX_TEST_HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CTX_HOME;
  delete process.env.CLAUDECODE;
  lines.length = 0;
  fs.mkdirSync(path.join(claudeDir(), 'plugins'), { recursive: true });
  const cfInstall = path.join(home, 'cf-install');
  fs.mkdirSync(path.join(cfInstall, 'skills', 'wrangler'), { recursive: true });
  fs.mkdirSync(path.join(cfInstall, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(cfInstall, '.claude-plugin', 'plugin.json'), JSON.stringify({ description: 'Cloudflare Workers, Wrangler and deploys. More text.' }));
  writeJson(path.join(claudeDir(), 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'cloudflare@cloudflare': [{ scope: 'user', installPath: cfInstall }],
      'watch@claude-video': [{ scope: 'user', installPath: path.join(home, 'nowhere') }],
    },
  });
  fs.writeFileSync(userFile(), USER_SETTINGS);
  A = path.join(home, 'proj A');
  B = path.join(home, 'proj B');
  C = path.join(home, 'proj C');
  for (const p of [A, B, C]) fs.mkdirSync(p, { recursive: true });
  transcript(A, 'a1', [
    ['deploy the worker with wrangler', [['Skill', { skill: 'cloudflare:wrangler' }], ['Bash', {}]]],
    ['wrangler tail the logs please', [['Skill', { skill: 'cloudflare:wrangler' }]]],
    ['watch this video', [['Skill', { skill: 'watch:watch' }]]],
  ]);
  transcript(B, 'b1', [['watch the clip and summarize', [['Skill', { skill: 'watch:watch' }]]], ['refactor parser', [['Edit', {}]]]]);
  transcript(C, 'c1', [['watch it', [['Skill', { skill: 'watch:watch' }]]], ['write the report docx', [['Skill', { skill: 'anthropic-skills:docx' }]]]]);
  measure(A, {
    'plugin:cloudflare@cloudflare': it_('plugin', 1300),
    'plugin:watch@claude-video': it_('plugin', 400),
    'skill:docx': it_('skill', 320, { method: 'listed', source: 'claude.ai sync', softDeltaTokens: 300 }),
    'skill:pdf': it_('skill', 300, { method: 'listed', source: 'claude.ai sync', softDeltaTokens: 280 }),
    'skill:tiny': it_('skill', 20, { method: 'listed', source: 'Built-in', softDeltaTokens: 5 }),
  });
});
afterEach(() => {
  delete process.env.CTX_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('registry and discovery', () => {
  it('maps transcript folders back to project roots via cwd and merges the registry', async () => {
    const ps = await discoverProjects();
    expect(ps.map((p) => p.key).sort()).toEqual([A, B, C].map(projectKey).sort());
    expect(ps.find((p) => p.key === projectKey(A))?.registered).toBe(true);
    expect(ps.find((p) => p.key === projectKey(B))?.registered).toBe(false);
    expect(Object.keys(loadRegistry().projects)).toEqual([projectKey(A)]);
  });

  it('skips folders whose project no longer exists', async () => {
    fs.rmSync(B, { recursive: true });
    const plan = await buildGlobalPlan();
    expect(plan.projects.map((p) => p.key)).not.toContain(projectKey(B));
  });
});

describe('projectUses', () => {
  const l = (items: Record<string, number>, reenables: Record<string, string[]> = {}): Ledger => ({
    project: '', builtAt: '', sessionsScanned: 1, window: { sessions: 10 }, sessions: [],
    items: Object.fromEntries(Object.entries(items).map(([k, n]) => [k, { sessionsUsed: n, calls: n }])), reenables,
    global: { skillUsage: {}, pluginUsage: {} },
  });
  it('counts plugin skills, agents and MCP servers, re-enables and profile pins', () => {
    expect(projectUses(l({ 'skill:cloudflare:wrangler': 1 }), 'plugin:cloudflare@cloudflare')).toBe(true);
    expect(projectUses(l({ 'agent:cloudflare:x': 1 }), 'plugin:cloudflare@cloudflare')).toBe(true);
    expect(projectUses(l({ 'mcp:plugin_cloudflare_api': 1 }), 'plugin:cloudflare@cloudflare')).toBe(true);
    expect(projectUses(l({ 'skill:watch:watch': 1 }), 'plugin:cloudflare@cloudflare')).toBe(false);
    expect(projectUses(l({}, { 'skill:pdf': ['2026'] }), 'skill:pdf')).toBe(true);
    expect(projectUses(undefined, 'skill:pdf', ['skill:pdf'])).toBe(true);
  });
});

describe('ctx global', () => {
  it('plans: extras off with keep-on where used, common items and small items left alone', async () => {
    const plan = await buildGlobalPlan();
    const by = Object.fromEntries(plan.items.map((i) => [i.id, i]));
    expect(by['plugin:cloudflare@cloudflare']).toMatchObject({ class: 'extra', action: 'off', tokens: 1300, keepOn: [path.resolve(A)] });
    expect(by['plugin:watch@claude-video']).toMatchObject({ class: 'common', action: 'none' });
    expect(by['skill:docx']).toMatchObject({ class: 'extra', action: 'soft', keepOn: [path.resolve(C)] });
    expect(by['skill:pdf']).toMatchObject({ class: 'unused', action: 'soft', keepOn: [] });
    expect(by['skill:tiny']).toMatchObject({ class: 'negligible', action: 'none' });
  });

  it('never trims ctx itself, and skips values the user set', async () => {
    const s = readJ(userFile());
    s.enabledPlugins['ctx@ctx'] = true;
    s.skillOverrides = { pdf: 'off' };
    fs.writeFileSync(userFile(), JSON.stringify(s));
    const plan = await buildGlobalPlan();
    const by = Object.fromEntries(plan.items.map((i) => [i.id, i]));
    expect(by['plugin:ctx@ctx']).toMatchObject({ class: 'protected', action: 'none' });
    expect(by['skill:pdf']).toMatchObject({ class: 'user-set', action: 'none' });
  });

  it('dry run writes nothing', async () => {
    const plan = await buildGlobalPlan();
    applyGlobal(plan, {}, out);
    expect(fs.readFileSync(userFile(), 'utf8')).toBe(USER_SETTINGS);
    expect(fs.existsSync(localFile(A))).toBe(false);
    expect(lines[0]).toMatch(/^Dry run/);
  });

  it('applies: user settings off (replacing true), keep-on in the using project; undo restores both byte for byte', async () => {
    const plan = await buildGlobalPlan();
    expect(applyGlobal(plan, { yes: true }, out)).toBe(0);
    const u = readJ(userFile());
    expect(u.enabledPlugins).toEqual({ 'cloudflare@cloudflare': false, 'watch@claude-video': true });
    expect(u.skillOverrides).toEqual({ docx: 'name-only', pdf: 'name-only' });
    expect(Object.keys(u)).toEqual(['model', 'enabledPlugins', 'skillOverrides']);
    expect(readJ(localFile(A))).toEqual({ enabledPlugins: { 'cloudflare@cloudflare': true } });
    expect(readJ(localFile(C))).toEqual({ skillOverrides: { docx: 'on' } });
    expect(fs.existsSync(localFile(B))).toBe(false);
    const g = loadApplied(globalTarget());
    expect(g.replaced).toEqual({ 'plugin:cloudflare@cloudflare': true });
    expect(Object.keys(g.projects ?? {}).sort()).toEqual([path.resolve(A), path.resolve(C)].sort());

    // Each project now loads its own extras only (the M4 acceptance, at settings level).
    const eff = (root: string) => effectivePlugins(loadScopes(root));
    expect(eff(A)['cloudflare@cloudflare']).toBe(true);
    expect(eff(B)['cloudflare@cloudflare']).toBe(false);

    // Re-applying is a no-op.
    lines.length = 0;
    applyGlobal(plan, { yes: true }, out);
    expect(lines.join('\n')).toContain('already matches the plan');

    lines.length = 0;
    expect(undoGlobal(out)).toBe(0);
    expect(fs.readFileSync(userFile(), 'utf8')).toBe(USER_SETTINGS);
    expect(fs.existsSync(localFile(A))).toBe(false);
    expect(fs.existsSync(localFile(C))).toBe(false);
    expect(loadApplied(globalTarget()).projects).toEqual({});
  });

  it('keeps an existing project file intact around a keep-on override', async () => {
    fs.mkdirSync(path.dirname(localFile(A)), { recursive: true });
    const original = '{\n    "permissions": {\n        "allow": ["Bash(npm:*)"]\n    }\n}\n';
    fs.writeFileSync(localFile(A), original);
    applyGlobal(await buildGlobalPlan(), { yes: true }, out);
    expect(readJ(localFile(A))).toEqual({ permissions: { allow: ['Bash(npm:*)'] }, enabledPlugins: { 'cloudflare@cloudflare': true } });
    undoGlobal(out);
    expect(fs.readFileSync(localFile(A), 'utf8')).toBe(original);
  });

  it('a project that trims the item locally keeps its choice (no keep-on)', async () => {
    writeSettings(A, 'test', (s, a) => [setEntry(s, a, { kind: 'plugin', id: 'cloudflare@cloudflare' })!]);
    applyGlobal(await buildGlobalPlan(), { yes: true }, out);
    expect(readJ(localFile(A)).enabledPlugins).toEqual({ 'cloudflare@cloudflare': false });
  });

  it('an item whose keep-on cannot be written stays on globally', async () => {
    fs.mkdirSync(path.dirname(localFile(A)), { recursive: true });
    fs.writeFileSync(localFile(A), '{ broken');
    applyGlobal(await buildGlobalPlan(), { yes: true }, out);
    expect(readJ(userFile()).enabledPlugins['cloudflare@cloudflare']).toBe(true);
    expect(lines.join('\n')).toMatch(/not valid JSON.*Leaving cloudflare@cloudflare on globally/);
  });

  it('applies only the chosen items and removes earlier entries no longer chosen', async () => {
    const plan = await buildGlobalPlan();
    applyGlobal(plan, { yes: true }, out);
    applyGlobal(plan, { yes: true, items: ['plugin:cloudflare@cloudflare'] }, out);
    expect(readJ(userFile()).skillOverrides).toBeUndefined();
    expect(fs.existsSync(localFile(C))).toBe(false); // docx keep-on pruned with its global entry
    expect(readJ(localFile(A)).enabledPlugins).toEqual({ 'cloudflare@cloudflare': true });
    expect(applyGlobal(plan, { yes: true, items: ['plugin:nope@x'] }, out)).toBe(2);
  });
});

describe('after ctx global', () => {
  beforeEach(async () => { applyGlobal(await buildGlobalPlan(), { yes: true }, () => {}); });

  it('the capability index lists the plugin where it is off, not where it is kept on', () => {
    expect(globalOffHere(A)).toEqual([]);
    expect(globalOffHere(B)).toEqual([{ id: 'cloudflare@cloudflare', description: 'Cloudflare Workers, Wrangler and deploys.' }]);
    const idx = capabilityIndex(hardOffEntries(undefined, loadScopes(B), globalOffHere(B)));
    expect(idx).toContain('- cloudflare plugin: Cloudflare Workers, Wrangler and deploys.');
  });

  it('ctx on in another project adds a local override and leaves user settings alone', () => {
    const before = fs.readFileSync(userFile(), 'utf8');
    expect(on(B, 'cloudflare', { reason: 'deploy' }, out)).toBe(0);
    expect(readJ(localFile(B))).toEqual({ enabledPlugins: { 'cloudflare@cloudflare': true } });
    expect(fs.readFileSync(userFile(), 'utf8')).toBe(before);
    expect(lines.join('\n')).toMatch(/user settings, by ctx global.*project-local override.*\/reload-plugins/s);
    // ...and the plan keeps it on there next time, through the recorded re-enable.
    lines.length = 0;
    expect(on(B, 'cloudflare', {}, out)).toBe(0);
    expect(lines[0]).toMatch(/already overrides it locally/);
  });

  it('the untrimmed reference keeps keep-on overrides', () => {
    expect(stripTrimKeys({ enabledPlugins: { a: false, b: true }, skillOverrides: { x: 'on', y: 'off' } }))
      .toEqual({ enabledPlugins: { b: true }, skillOverrides: { x: 'on' } });
    expect(effectivePlugins(loadScopes(A), { skipLocal: true })['cloudflare@cloudflare']).toBe(true);
  });

  it('project apply never removes keep-on overrides it did not plan', () => {
    const s = readJ(localFile(A));
    const a = loadApplied(A);
    expect(clearEntry(s, a, { kind: 'plugin', id: 'cloudflare@cloudflare' })).toBe('absent'); // a trim ref doesn't match "on"
    expect(clearEntry(s, a, { kind: 'plugin', id: 'cloudflare@cloudflare', value: true })).toBe('removed');
  });
});

describe('learned triggers', () => {
  it('tokenizes prompts without stop words and splits hyphens', () => {
    expect(tokenize('Please deploy the durable-objects worker, then run it!')).toEqual(
      ['deploy', 'durable-objects', 'durable', 'objects', 'worker']);
  });

  it('name keywords skip short and generic names', () => {
    expect(nameKeywords('plugin:cloudflare@cloudflare', ['wrangler', 'agents', 'durable-objects']))
      .toEqual(['cloudflare', 'wrangler', 'durable-objects']);
    expect(nameKeywords('skill:run')).toEqual([]);
    expect(nameKeywords('skill:loop')).toEqual([]);
    expect(nameKeywords('skill:docx')).toEqual(['docx']);
    expect(nameKeywords('tool:ScheduleWakeup')).toEqual(['schedulewakeup']);
    expect(nameKeywords('tool:PowerShell')).toEqual(['powershell']);
    expect(nameKeywords('tool:Artifact')).toEqual(['artifact']);
  });

  it('learns words that precede an item and scores prompts', async () => {
    const t = await learnTriggers(await discoverProjects());
    const cf = t.items['plugin:cloudflare@cloudflare'];
    expect(cf.prompts).toBe(2);
    expect(cf.keywords.map((k) => k.word)).toEqual(expect.arrayContaining(['cloudflare', 'wrangler']));
    expect(t.items['skill:docx'].keywords[0]).toMatchObject({ word: 'docx', source: 'name' });
    const m = scorePrompt('can you wrangler deploy this', ['plugin:cloudflare@cloudflare', 'skill:docx'], t);
    expect(m).toEqual([{ id: 'plugin:cloudflare@cloudflare', score: 1, words: ['wrangler'] }]);
    expect(scorePrompt('refactor the parser', ['plugin:cloudflare@cloudflare'], t)).toEqual([]);
  });

  it('prompt-submit hook: off by default; with auto on, switches a matching off item on and says so', async () => {
    applyGlobal(await buildGlobalPlan(), { yes: true }, () => {});
    await learnTriggers(await discoverProjects());
    expect(offCandidates(B)).toEqual(['plugin:cloudflare@cloudflare']);
    expect(promptSubmit(B, 'deploy with wrangler')).toEqual({});
    saveConfig({ auto: true });
    expect(promptSubmit(B, 'refactor the parser')).toEqual({});
    const r = promptSubmit(B, 'deploy with wrangler');
    expect(r.systemMessage).toBe('ctx: switched on cloudflare (run /reload-plugins to load it now) for this prompt. /ctx:auto off disables this.');
    expect(r.hookSpecificOutput?.additionalContext).toMatch(/^ctx switched plugin:cloudflare@cloudflare back on because the prompt mentions "wrangler"/);
    expect(readJ(localFile(B))).toEqual({ enabledPlugins: { 'cloudflare@cloudflare': true } });
    expect(offCandidates(B)).toEqual([]);
  });
});
