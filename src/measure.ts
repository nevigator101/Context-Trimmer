import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findClaude, type ClaudeBinary } from './binary.js';
import { pluginOfSource, type ContextReport } from './parse.js';
import { projectKey, projectStateDir, readJson, writeJson } from './paths.js';
import { captureRequest, firstSentence, pool, runContext, type RunSpec } from './runner.js';
import {
  effectivePlugins, installedPlugins, loadScopes, pluginDescriptions, stripTrimKeys, type Json, type SettingsFile,
} from './settings.js';

export const SEED_TOOLS = [
  'Agent', 'Artifact', 'AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep', 'ListAgents', 'PowerShell', 'Read',
  'ReportFindings', 'ScheduleWakeup', 'Skill', 'ToolSearch', 'Write',
];
/** Denying these makes context larger or is impossible (spec §2.3); never toggled. */
export const NEVER_TOGGLE = new Set(['Skill', 'ToolSearch', 'EndConversation', 'DeferredToolPlaceholder']);

export interface RunSummary {
  totalTokens: number;
  /** totalTokens adjusted for the /context skills quirk (VERIFY.md item 6). */
  correctedTokens: number;
  categories: Record<string, number>;
}

export interface ItemMeasurement {
  kind: 'tool' | 'plugin' | 'skill' | 'mcp' | 'memory';
  category: string;
  /** Tokens saved when the item is fully off. */
  deltaTokens: number;
  /** Tokens saved at the soft level (skills: name-only). */
  softDeltaTokens?: number;
  method: 'toggle' | 'listed';
  source?: string;
  plugin?: string;
  description?: string;
  /** Deferred (not upfront) tokens, informational. */
  deferredTokens?: number;
  unmeasured?: string;
}

export interface Measurement {
  ccVersion: string;
  binary: string;
  model?: string;
  project: string;
  measuredAt: string;
  fingerprint: string;
  /** Untrimmed config: local trim keys removed. */
  reference: RunSummary;
  /** Config as it is now. */
  current: RunSummary;
  /** /context's total ignores skill/plugin changes (VERIFY.md item 6). */
  skillsQuirk: boolean;
  toolDiscovery: 'capture' | 'seed';
  upfrontTools: string[];
  /** Input schemas of upfront tools, so `ctx on` can show Claude how to call a re-enabled tool. */
  toolSchemas: Record<string, unknown>;
  /** First sentence of each skill's description (from the captured skill listing). */
  skillDescriptions?: Record<string, string>;
  items: Record<string, ItemMeasurement>;
  skills: { name: string; source: string; tokens: number; plugin?: string }[];
  mcpServers: Record<string, { tools: number; deferredTokens: number }>;
  memoryFiles: { path: string; type: string; tokens: number }[];
  unparsed: string[];
}

export function measurementPath(root: string): string {
  return path.join(projectStateDir(root), 'measurement.json');
}

export function loadMeasurement(root: string): Measurement | undefined {
  return readJson<Measurement>(measurementPath(root));
}

/** Fingerprint of everything that changes upfront context, so cached costs are reused only when valid. */
export function fingerprint(root: string, scopes: SettingsFile[], ccVersion: string): string {
  const h = createHash('sha256').update(ccVersion);
  // The local file is hashed without its trim keys, so applying a profile keeps cached costs valid.
  const local = scopes.find((s) => s.scope === 'local');
  h.update(`local:${local?.exists ? JSON.stringify(stripTrimKeys(local.data)) : 'absent'}`);
  const files = [
    ...scopes.filter((s) => s.scope !== 'local').map((s) => s.path),
    path.join(root, '.mcp.json'),
    path.join(root, 'CLAUDE.md'),
    path.join(root, '.claude', 'CLAUDE.md'),
  ];
  for (const f of files) {
    try { h.update(f).update(fs.readFileSync(f)); } catch { h.update(`${f}:absent`); }
  }
  return h.digest('hex').slice(0, 16);
}

/** The run spec for the untrimmed reference: local file excluded, its non-trim keys re-applied as flags. */
export function referenceSpec(scopes: SettingsFile[]): RunSpec {
  const local = scopes.find((s) => s.scope === 'local');
  return { settingSources: 'user,project', settings: stripTrimKeys(local?.data) };
}

function withExtra(spec: RunSpec, extra: Json): RunSpec {
  const s: Json = JSON.parse(JSON.stringify(spec.settings ?? {})) as Json;
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'permissions') {
      const cur = (s.permissions ?? {}) as Json;
      const deny = [...((cur.deny as string[] | undefined) ?? []), ...(((v as Json).deny as string[]) ?? [])];
      s.permissions = { ...cur, deny };
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      s[k] = { ...((s[k] as Json | undefined) ?? {}), ...(v as Json) };
    } else {
      s[k] = v;
    }
  }
  return { ...spec, settings: s };
}

function summarize(r: ContextReport, refSkills: number | undefined, quirk: boolean): RunSummary {
  const total = r.totalTokens ?? 0;
  const skills = r.categories['Skills'] ?? 0;
  const adj = quirk && refSkills !== undefined ? refSkills - skills : 0;
  return { totalTokens: total, correctedTokens: total - adj, categories: r.categories };
}

export interface MeasureOptions {
  full?: boolean;
  only?: string;
  log?: (line: string) => void;
}

export async function measure(root: string, opts: MeasureOptions = {}): Promise<Measurement> {
  const log = opts.log ?? (() => {});
  const bin: ClaudeBinary | null = findClaude();
  if (!bin) throw new Error('Claude Code binary not found. Set CTX_CLAUDE_BIN to the path of claude(.exe). Run `ctx doctor`.');
  const scopes = loadScopes(root);
  const fp = fingerprint(root, scopes, bin.version);
  const cached = loadMeasurement(root);
  if (cached && !opts.full && !opts.only && cached.fingerprint === fp) {
    log(`Using cached measurement from ${cached.measuredAt} (settings unchanged).`);
    return cached;
  }

  const ref = referenceSpec(scopes);
  log(`Claude Code ${bin.version} at ${bin.path}`);
  log('Measuring reference (untrimmed) and current context...');
  const [refRun, curRun, cap] = await Promise.all([
    runContext(bin.path, root, ref),
    runContext(bin.path, root, {}),
    captureRequest(bin.path, root, ref).catch(() => null),
  ]);
  if (!refRun.ok || !refRun.report) throw new Error(`/context failed for the reference run: ${refRun.error}`);
  if (!curRun.ok || !curRun.report) throw new Error(`/context failed for the current config: ${curRun.error}`);
  const refR = refRun.report;
  const refSkills = refR.categories['Skills'];

  // Upfront tool list.
  const toolDescriptions = new Map<string, string>();
  const toolSchemas: Record<string, unknown> = {};
  let upfront: string[];
  let discovery: Measurement['toolDiscovery'] = 'seed';
  if (cap && cap.tools.length) {
    discovery = 'capture';
    upfront = cap.tools.filter((t) => !t.deferred).map((t) => t.name);
    for (const t of cap.tools) {
      toolDescriptions.set(t.name, t.description);
      if (!t.deferred && t.inputSchema) toolSchemas[t.name] = t.inputSchema;
    }
  } else {
    upfront = [...new Set([...SEED_TOOLS, ...Object.keys(cached?.items ?? {}).filter((k) => k.startsWith('tool:')).map((k) => k.slice(5))])];
  }

  // Plugins that are enabled in the reference config.
  const eff = effectivePlugins(scopes, { skipLocal: true });
  const plugins = [...new Set([...installedPlugins(root), ...Object.keys(eff)])].filter((p) => eff[p] !== false);

  const nonPluginSkills = refR.skills.filter((s) => !pluginOfSource(s.source));
  type Job = { id: string; spec: RunSpec };
  let jobs: Job[] = [
    ...upfront.filter((t) => !NEVER_TOGGLE.has(t)).map((t) => ({ id: `tool:${t}`, spec: withExtra(ref, { permissions: { deny: [t] } }) })),
    ...plugins.map((p) => ({ id: `plugin:${p}`, spec: withExtra(ref, { enabledPlugins: { [p]: false } }) })),
  ];
  if (nonPluginSkills.length) {
    jobs.push({
      id: 'group:skills-name-only',
      spec: withExtra(ref, { skillOverrides: Object.fromEntries(nonPluginSkills.map((s) => [s.name, 'name-only'])) }),
    });
  }
  if (opts.only) jobs = jobs.filter((j) => j.id === opts.only || j.id === 'group:skills-name-only');

  log(`Running ${jobs.length} toggle measurements (3 at a time, ~4 s each)...`);
  let done = 0;
  const results = await pool(jobs, 3, async (j) => {
    const r = await runContext(bin.path, root, j.spec);
    done++;
    log(`  [${done}/${jobs.length}] ${j.id}: ${r.ok ? `${r.report?.totalTokens}` : `failed (${r.error})`}`);
    return { job: j, r };
  });

  // Detect the skills quirk from the skills group run (or a plugin run).
  let quirk = cached?.skillsQuirk ?? false;
  const probe = results.find((x) => x.job.id === 'group:skills-name-only' && x.r.ok)
    ?? results.find((x) => x.job.id.startsWith('plugin:') && x.r.ok);
  if (probe?.r.report && refSkills !== undefined) {
    const dSkills = refSkills - (probe.r.report.categories['Skills'] ?? refSkills);
    const dTotal = (refR.totalTokens ?? 0) - (probe.r.report.totalTokens ?? 0);
    if (dSkills >= 200) quirk = dTotal < dSkills / 2;
  }

  const reference = summarize(refR, refSkills, quirk);
  const items: Record<string, ItemMeasurement> = opts.only && cached ? { ...cached.items } : {};
  const pluginDesc = pluginDescriptions();
  for (const [id, d] of Object.entries(pluginDesc)) toolDescriptions.set(id, firstSentence(d));
  for (const { job, r } of results) {
    if (job.id.startsWith('group:')) continue;
    const kind = job.id.startsWith('tool:') ? 'tool' : 'plugin';
    const name = job.id.slice(job.id.indexOf(':') + 1);
    if (!r.ok || !r.report) {
      items[job.id] = { kind, category: kind === 'tool' ? 'System tools' : 'Skills', deltaTokens: 0, method: 'toggle', unmeasured: r.error };
      continue;
    }
    const run = summarize(r.report, refSkills, quirk);
    items[job.id] = {
      kind,
      category: kind === 'tool' ? 'System tools' : 'Skills',
      deltaTokens: Math.max(0, reference.correctedTokens - run.correctedTokens),
      method: 'toggle',
      ...(toolDescriptions.get(name) ? { description: toolDescriptions.get(name) } : {}),
    };
  }

  // Skills: listed values. Soft (name-only) saving = listed minus the name-only cost estimated from the group run.
  const group = results.find((x) => x.job.id === 'group:skills-name-only' && x.r.ok)?.r.report;
  let nameOnlyCost = 15;
  if (group && nonPluginSkills.length) {
    const pluginSkillTokens = refR.skills.filter((s) => pluginOfSource(s.source)).reduce((a, s) => a + s.tokens, 0);
    const est = ((group.categories['Skills'] ?? 0) - pluginSkillTokens) / nonPluginSkills.length;
    if (est > 0 && est < 60) nameOnlyCost = Math.round(est);
  }
  for (const s of refR.skills) {
    const plugin = pluginOfSource(s.source);
    if (plugin) continue; // plugin skills can't be overridden (VERIFY.md item 7); their plugin is the lever
    items[`skill:${s.name}`] = {
      kind: 'skill', category: 'Skills', method: 'listed', source: s.source,
      deltaTokens: s.tokens, softDeltaTokens: Math.max(0, s.tokens - nameOnlyCost),
    };
  }

  const mcpServers: Measurement['mcpServers'] = {};
  for (const t of refR.mcpTools) {
    const m = (mcpServers[t.server] ??= { tools: 0, deferredTokens: 0 });
    m.tools++;
    m.deferredTokens += t.tokens;
  }
  for (const [server, m] of Object.entries(mcpServers)) {
    items[`mcp:${server}`] = { kind: 'mcp', category: 'MCP tools', method: 'listed', deltaTokens: 0, deferredTokens: m.deferredTokens };
  }
  for (const f of refR.memoryFiles) {
    items[`memory:${f.path}`] = { kind: 'memory', category: 'Memory files', method: 'listed', deltaTokens: f.tokens, source: f.type };
  }

  const m: Measurement = {
    ccVersion: bin.version,
    binary: bin.path,
    model: refR.model,
    project: projectKey(root),
    measuredAt: new Date().toISOString(),
    fingerprint: fp,
    reference,
    current: summarize(curRun.report, refSkills, quirk),
    skillsQuirk: quirk,
    toolDiscovery: discovery,
    upfrontTools: upfront,
    toolSchemas: Object.keys(toolSchemas).length ? toolSchemas : (cached?.toolSchemas ?? {}),
    skillDescriptions: cap && Object.keys(cap.skillDescriptions).length ? cap.skillDescriptions : (cached?.skillDescriptions ?? {}),
    items,
    skills: refR.skills.map((s) => ({ name: s.name, source: s.source, tokens: s.tokens, plugin: pluginOfSource(s.source) })),
    mcpServers,
    memoryFiles: refR.memoryFiles.map((f) => ({ path: f.path, type: f.type, tokens: f.tokens })),
    unparsed: refR.unparsed.map((u) => u.heading),
  };
  writeJson(measurementPath(root), m);
  return m;
}

/** One verification run of an arbitrary settings overlay on top of the current config. */
export async function verifyRun(root: string, settings: Json, reference: RunSummary, quirk: boolean): Promise<RunSummary> {
  const bin = findClaude();
  if (!bin) throw new Error('Claude Code binary not found.');
  const r = await runContext(bin.path, root, { settings });
  if (!r.ok || !r.report) throw new Error(`verification /context failed: ${r.error}`);
  return summarize(r.report, reference.categories['Skills'], quirk);
}
