import { describe, expect, it } from 'vitest';
import type { ItemMeasurement, Measurement } from '../src/measure.js';
import { buildPlan, groupSummary, reviewPlan } from '../src/plan.js';
import { protectedIds } from '../src/protect.js';
import type { Ledger } from '../src/usage.js';

const tool = (delta: number): ItemMeasurement => ({ kind: 'tool', category: 'System tools', deltaTokens: delta, method: 'toggle' });
const plugin = (delta: number): ItemMeasurement => ({ kind: 'plugin', category: 'Skills', deltaTokens: delta, method: 'toggle' });
const skill = (delta: number): ItemMeasurement => ({ kind: 'skill', category: 'Skills', deltaTokens: delta, softDeltaTokens: Math.max(0, delta - 15), method: 'listed', source: 'Built-in' });

function measurement(items: Record<string, ItemMeasurement>): Measurement {
  const run = { totalTokens: 30600, correctedTokens: 30600, categories: {} };
  return {
    ccVersion: '2.1.326', binary: 'claude', project: 'c:/p', measuredAt: '2026-11-18T00:00:00Z', fingerprint: 'x',
    reference: run, current: run, skillsQuirk: true, toolDiscovery: 'capture', upfrontTools: [], toolSchemas: {},
    items, skills: [], mcpServers: {}, memoryFiles: [], unparsed: [],
  };
}

function ledger(items: Record<string, number>, sessions = 10, extra: Partial<Ledger> = {}): Ledger {
  return {
    project: 'c:/p', builtAt: '', sessionsScanned: sessions, window: { sessions: 10 },
    sessions: Array.from({ length: sessions }, (_, i) => ({ id: `s${i}`, file: '', mtime: '', calls: 1 })),
    items: Object.fromEntries(Object.entries(items).map(([k, n]) => [k, { sessionsUsed: n, calls: n }])),
    reenables: {}, global: { skillUsage: {}, pluginUsage: {} }, ...extra,
  };
}

const ITEMS = {
  'tool:Bash': tool(5300), 'tool:Read': tool(700), 'tool:PowerShell': tool(3800), 'tool:Artifact': tool(12000),
  'tool:ScheduleWakeup': tool(1700), 'tool:ReportFindings': tool(800), 'tool:ListAgents': tool(300), 'tool:Write': tool(200),
  'tool:Agent': tool(1400), 'tool:Grep': tool(1300),
  'plugin:cloudflare@cloudflare': plugin(1300), 'plugin:watch@claude-video': plugin(100),
  'skill:dataviz': skill(480), 'skill:loop': skill(20), 'skill:code-review': skill(400), 'skill:docx': skill(320),
  'skill:artifact-design': skill(70), 'skill:artifact-capabilities': skill(250), 'skill:gepeto': skill(30),
};
const prot = (l?: Ledger) => protectedIds({ ledger: l, platform: 'win32' });
const byId = (p: ReturnType<typeof buildPlan>) => Object.fromEntries(p.items.map((i) => [i.id, i]));

describe('buildPlan', () => {
  it('classifies per the rules, first match wins', () => {
    const l = ledger({ 'tool:Bash': 9, 'tool:Read': 10, 'skill:watch:watch': 2, 'tool:PowerShell': 3 });
    const p = byId(buildPlan(measurement(ITEMS), l, undefined, { protectedIds: prot(l) }));
    expect(p['tool:Bash']).toMatchObject({ class: 'protected', action: 'none' });
    expect(p['tool:PowerShell']).toMatchObject({ class: 'protected', action: 'none' });
    expect(p['tool:Artifact']).toMatchObject({ class: 'unused', action: 'off', group: 'tools', saveTokens: 12000 });
    expect(p['tool:ListAgents']).toMatchObject({ class: 'unused', action: 'off' });
    expect(p['tool:Write']).toMatchObject({ class: 'protected' });
    expect(p['tool:Agent']).toMatchObject({ class: 'protected' });
    expect(p['plugin:watch@claude-video']).toMatchObject({ class: 'used', action: 'none' });
    expect(p['plugin:cloudflare@cloudflare']).toMatchObject({ action: 'off', group: 'plugins' });
    expect(p['skill:dataviz']).toMatchObject({ class: 'unused', action: 'soft', group: 'skills', saveTokens: 465 });
    expect(p['skill:gepeto']).toMatchObject({ class: 'negligible', action: 'none' });
  });

  it('S2: never proposes a default-group hard-off for anything used in the window', () => {
    const l = ledger({ 'tool:Artifact': 1, 'tool:ScheduleWakeup': 4, 'tool:ListAgents': 1 });
    const plan = buildPlan(measurement(ITEMS), l, undefined, { protectedIds: prot(l) });
    for (const i of plan.items) {
      if ((l.items[i.id]?.sessionsUsed ?? 0) > 0 && i.action === 'off') expect(i.group).toBe('rare');
    }
    const p = byId(plan);
    expect(p['tool:Artifact']).toMatchObject({ class: 'rare', group: 'rare' });
    expect(p['tool:ListAgents']).toMatchObject({ class: 'used', action: 'none' });
  });

  it('dependencies: skills follow their tool; a used skill keeps its tool', () => {
    const l = ledger({ 'skill:code-review': 1 });
    const p = byId(buildPlan(measurement(ITEMS), l, undefined, { protectedIds: prot(l) }));
    expect(p['skill:artifact-design']).toMatchObject({ action: 'soft', group: 'tools' });
    expect(p['skill:loop']).toMatchObject({ action: 'soft', group: 'tools' });
    expect(p['tool:ReportFindings']).toMatchObject({ class: 'needed', action: 'none' });
  });

  it('project signals and pins keep items; aggressive turns unused skills off', () => {
    const l = ledger({});
    const profile = { services: ['Cloudflare Workers'], workTypes: ['docs'], keep: ['tool:Artifact'] };
    const p = byId(buildPlan(measurement(ITEMS), l, profile, { protectedIds: prot(l), aggressive: true }));
    expect(p['plugin:cloudflare@cloudflare']).toMatchObject({ class: 'likely', action: 'none' });
    expect(p['tool:Artifact']).toMatchObject({ class: 'kept', action: 'none' });
    expect(p['skill:docx']).toMatchObject({ class: 'likely', action: 'soft' });
    expect(p['skill:code-review']).toMatchObject({ class: 'unused', action: 'off', group: 'skills-off' });
  });

  it('a re-enabled item is not trimmed again (inside the usage window)', () => {
    const sessions = [{ id: 's0', file: '', mtime: '2026-11-10T00:00:00.000Z', calls: 1 }];
    const l = ledger({}, 1, {
      sessions,
      reenables: { 'tool:ListAgents': ['2026-11-12T10:00:00.000Z publish a page'], 'tool:Artifact': ['2026-11-01T00:00:00.000Z old'] },
    });
    const p = byId(buildPlan(measurement(ITEMS), l, undefined, { protectedIds: prot(l) }));
    expect(p['tool:ListAgents']).toMatchObject({ class: 'used', action: 'none', reason: 're-enabled once recently' });
    expect(p['tool:Artifact']).toMatchObject({ action: 'off' });
  });

  it('foreign plugins and skills', () => {
    const l = ledger({}, 10, { global: { skillUsage: { 'anthropic-skills:docx': { usageCount: 4 } }, pluginUsage: { 'cloudflare@cloudflare': { usageCount: 9 } } } });
    const p = byId(buildPlan(measurement(ITEMS), l, undefined, { protectedIds: prot(l) }));
    expect(p['plugin:cloudflare@cloudflare']).toMatchObject({ class: 'foreign', action: 'off' });
    expect(p['skill:docx']).toMatchObject({ class: 'foreign', action: 'soft' });
  });

  it('groups sum savings', () => {
    const l = ledger({});
    const g = groupSummary(buildPlan(measurement(ITEMS), l, undefined, { protectedIds: prot(l) }));
    expect(g.find((x) => x.group === 'tools')!.tokens).toBeGreaterThan(14000);
  });
});

describe('reviewPlan', () => {
  const l = ledger({});
  const draft = buildPlan(measurement(ITEMS), l, undefined, { protectedIds: prot(l) });
  it('allows more conservative moves and none->soft for skills only', () => {
    const r = reviewPlan(draft, JSON.stringify({ items: [
      { id: 'tool:Artifact', action: 'none', reason: 'docs project' },
      { id: 'skill:gepeto', action: 'soft' },
      { id: 'tool:Bash', action: 'off' },
      { id: 'tool:Read', action: 'soft' },
      { id: 'skill:nope', action: 'none' },
    ] }));
    const p = byId(r.plan);
    expect(p['tool:Artifact']).toMatchObject({ action: 'none', saveTokens: 0 });
    expect(p['skill:gepeto']).toMatchObject({ action: 'soft', group: 'skills' });
    expect(p['tool:Bash'].action).toBe('none');
    expect(r.rejected).toHaveLength(3);
    expect(r.plan.reviewed).toBe(true);
  });
});
