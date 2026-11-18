import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capabilityIndex, hardOffEntries, INDEX_HEADER, sessionStart } from '../src/hook.js';
import type { ItemMeasurement, Measurement } from '../src/measure.js';
import { measurementPath } from '../src/measure.js';
import { writeJson } from '../src/paths.js';
import type { SettingsFile } from '../src/settings.js';
import { setEntry, writeSettings } from '../src/writer.js';

const item = (kind: ItemMeasurement['kind'], delta: number, description?: string): ItemMeasurement =>
  ({ kind, category: 'x', deltaTokens: delta, method: 'toggle', ...(description ? { description } : {}) });

function measurement(current: number): Measurement {
  const run = (t: number) => ({ totalTokens: t, correctedTokens: t, categories: { Skills: 7300 } });
  return {
    ccVersion: '2.1.326', binary: 'claude', project: 'c:/p', measuredAt: '2026-11-18T00:00:00Z', fingerprint: 'x',
    reference: run(30600), current: run(current), skillsQuirk: true, toolDiscovery: 'capture', upfrontTools: [], toolSchemas: {},
    skillDescriptions: { pdf: 'Work with PDF files.' },
    items: {
      'tool:Artifact': item('tool', 12000, 'Publish or open web pages and docs.'),
      'tool:ScheduleWakeup': item('tool', 1700, 'Schedule when to resume work.'),
      'tool:ListAgents': item('tool', 300),
      'plugin:cloudflare@cloudflare': item('plugin', 1300, 'Workers, Wrangler, D1/R2/KV, Cloudflare deploys.'),
    },
    skills: [], mcpServers: {}, memoryFiles: [], unparsed: [],
  };
}

/** S5 budget (spec: 300 ms). Shared CI runners can set CTX_LATENCY_BUDGET_MS higher; regressions still show. */
const LATENCY_BUDGET_MS = Number(process.env.CTX_LATENCY_BUDGET_MS ?? 300);

const local = (data: Record<string, unknown>): SettingsFile[] => [{ scope: 'local', path: 'l', exists: true, data }];

describe('capability index', () => {
  it('lists hard-off items from local settings only, with descriptions and notes', () => {
    const scopes: SettingsFile[] = [
      { scope: 'user', path: 'u', exists: true, data: { permissions: { deny: ['WebSearch'] } } },
      ...local({
        permissions: { deny: ['Artifact', 'ScheduleWakeup', 'Bash(rm:*)'] },
        enabledPlugins: { 'cloudflare@cloudflare': false, 'watch@claude-video': true },
        skillOverrides: { pdf: 'off', docx: 'name-only' },
      }),
    ];
    expect(capabilityIndex(hardOffEntries(measurement(16000), scopes))).toBe([
      INDEX_HEADER,
      '- Artifact tool: Publish or open web pages and docs.',
      '- ScheduleWakeup tool: Schedule when to resume work. (needed by /loop)',
      '- cloudflare plugin: Workers, Wrangler, D1/R2/KV, Cloudflare deploys.',
      '- pdf skill: Work with PDF files.',
    ].join('\n'));
  });

  it('is empty when only name-only skills are trimmed', () => {
    expect(capabilityIndex(hardOffEntries(measurement(16000), local({ skillOverrides: { docx: 'name-only' } })))).toBeUndefined();
  });

  it('stays under the 400-token budget', () => {
    const deny = Array.from({ length: 200 }, (_, i) => `Tool${i}`);
    const text = capabilityIndex(hardOffEntries(measurement(16000), local({ permissions: { deny } })))!;
    expect(text.length).toBeLessThanOrEqual(1600);
    expect(text).toMatch(/\.\.\. and \d+ more \(see \/ctx:report\)$/);
  });
});

describe('sessionStart', () => {
  let root: string;
  let state: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx hook '));
    state = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hook-state-'));
    process.env.CTX_HOME = state;
    process.env.CTX_TEST_HOME = state; // isolate ~/.claude reads (protected list, transcripts)
  });
  afterEach(() => {
    delete process.env.CTX_HOME;
    delete process.env.CTX_TEST_HOME;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  });

  it('says nothing for an unmeasured project', () => {
    expect(sessionStart(root)).toEqual({});
  });

  it('suggests setup when a large project has no profile', () => {
    writeJson(measurementPath(root), measurement(30600));
    expect(sessionStart(root).systemMessage).toMatch(/^ctx: this project loads 30\.6K upfront; \/ctx:setup could cut ~\d/);
  });

  it('reports an active profile and adds the index', () => {
    writeJson(measurementPath(root), measurement(16700));
    writeSettings(root, 'test', (s, a) => [setEntry(s, a, { kind: 'tool', name: 'Artifact' })!]);
    const out = sessionStart(root);
    expect(out.systemMessage).toBe('ctx: lean profile active (16.7K upfront, 1 items trimmed). /ctx:report for details.');
    expect(out.hookSpecificOutput?.additionalContext).toContain('- Artifact tool: Publish or open web pages and docs.');
  });

  it('S5: the bundled hook answers in under 300 ms', () => {
    const cli = path.resolve(__dirname, '..', 'ctx', 'dist', 'ctx.mjs');
    if (!fs.existsSync(cli)) return;
    writeJson(measurementPath(root), measurement(16700));
    writeSettings(root, 'test', (s, a) => [setEntry(s, a, { kind: 'tool', name: 'Artifact' })!]);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    spawnSync(process.execPath, [cli, 'hook', 'session-start'], { env, input: '{}' }); // warm the file cache
    const times: number[] = [];
    let stdout = '';
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const r = spawnSync(process.execPath, [cli, 'hook', 'session-start'], { env, input: '{"source":"startup"}', encoding: 'utf8' });
      times.push(performance.now() - t);
      stdout = r.stdout;
    }
    expect(JSON.parse(stdout).hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(Math.min(...times)).toBeLessThan(LATENCY_BUDGET_MS);
  });

  it('prompt-submit hook (runs on every prompt) is silent and fast with auto off and on', () => {
    const cli = path.resolve(__dirname, '..', 'ctx', 'dist', 'ctx.mjs');
    if (!fs.existsSync(cli)) return;
    writeJson(measurementPath(root), measurement(16700));
    writeSettings(root, 'test', (s, a) => [setEntry(s, a, { kind: 'tool', name: 'Artifact' })!]);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    const run = () => {
      const t = performance.now();
      const r = spawnSync(process.execPath, [cli, 'hook', 'prompt-submit'], { env, input: '{"prompt":"refactor the parser"}', encoding: 'utf8' });
      return { ms: performance.now() - t, out: r.stdout };
    };
    run();
    const off = [run(), run(), run()];
    expect(off.every((r) => r.out === '')).toBe(true);
    expect(Math.min(...off.map((r) => r.ms))).toBeLessThan(LATENCY_BUDGET_MS);
    writeJson(path.join(state, 'config.json'), { auto: true });
    writeJson(path.join(state, 'triggers.json'), { version: 1, learnedAt: new Date().toISOString(), sessions: 1, prompts: 1,
      items: { 'tool:Artifact': { prompts: 1, keywords: [{ word: 'artifact', weight: 1, hits: 1, source: 'name' }] } } });
    const on = [run(), run(), run()];
    expect(on.every((r) => r.out === '')).toBe(true); // no match: still silent
    expect(Math.min(...on.map((r) => r.ms))).toBeLessThan(LATENCY_BUDGET_MS);
  });
});
