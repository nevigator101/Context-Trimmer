import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transcriptSlug } from '../src/paths.js';
import { buildLedger, itemsForToolUse, normalizeSkillName } from '../src/usage.js';

describe('itemsForToolUse', () => {
  it('maps tools, skills, agents, mcp', () => {
    expect(itemsForToolUse('Bash', {})).toEqual(['tool:Bash']);
    expect(itemsForToolUse('Skill', { skill: 'anthropic-skills:docs' })).toEqual(['tool:Skill', 'skill:docs']);
    expect(itemsForToolUse('Skill', { skill: 'watch:watch' })).toEqual(['tool:Skill', 'skill:watch:watch']);
    expect(itemsForToolUse('Agent', { subagent_type: 'Explore' })).toEqual(['tool:Agent', 'agent:Explore']);
    expect(itemsForToolUse('mcp__claude_ai_Google_Drive__copy_file', {})).toEqual(['mcp:claude_ai_Google_Drive']);
    expect(itemsForToolUse('mcp__bad', {})).toEqual([]);
  });
  it('normalizes synced skill names', () => {
    expect(normalizeSkillName('anthropic-skills:pdf')).toBe('pdf');
    expect(normalizeSkillName('cloudflare:wrangler')).toBe('cloudflare:wrangler');
  });
});

describe('buildLedger', () => {
  let home: string;
  const root = path.join(os.tmpdir(), 'ctx test proj');
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  const asst = (ts: string, ...uses: [string, Record<string, unknown>][]) => line({
    type: 'assistant', timestamp: ts, isSidechain: false,
    message: {
      role: 'assistant',
      content: [{ type: 'thinking' }, ...uses.map(([name, input]) => ({ type: 'tool_use', id: 'x', name, input }))],
    },
  });

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-home-'));
    process.env.CTX_TEST_HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.CTX_HOME = path.join(home, 'ctxstate');
    const slug = transcriptSlug(root);
    // Directories differing only in first-letter case (drive letter on Windows) must be merged.
    const flip = (c: string) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase());
    const d1 = path.join(home, '.claude', 'projects', slug);
    const d2 = path.join(home, '.claude', 'projects', slug.replace(/[A-Za-z]/, flip));
    fs.mkdirSync(d1, { recursive: true });
    fs.mkdirSync(d2, { recursive: true }); // same dir on case-insensitive file systems
    const t = (f: string, body: string, mtime: number, dir = d1) => {
      const p = path.join(dir, f);
      fs.writeFileSync(p, body);
      fs.utimesSync(p, mtime, mtime);
    };
    t('s1.jsonl', asst('2026-11-01T10:00:00Z', ['Bash', {}], ['Read', {}]) + 'not json\n'
      + asst('2026-11-01T10:05:00Z', ['Bash', {}]), 1000);
    t('s2.jsonl', line({ type: 'user', timestamp: '2026-11-02T09:00:00Z', message: { content: '<command-name>/watch:watch</command-name>' } })
      + asst('2026-11-02T09:01:00Z', ['Skill', { skill: 'anthropic-skills:docx' }], ['mcp__MCP_DOCKER__get_me', {}]), 2000, d2);
    // A /context measurement session: no assistant turns, so it's excluded.
    t('s3.jsonl', line({ type: 'user', message: { content: '<command-name>/context</command-name>' } }), 3000);
    // Subagent transcript of s1.
    fs.mkdirSync(path.join(d1, 's1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(d1, 's1', 'subagents', 'agent-a.jsonl'), asst('2026-11-01T10:02:00Z', ['WebFetch', {}]));
    fs.writeFileSync(path.join(home, '.claude.json'),
      JSON.stringify({ skillUsage: { docx: { usageCount: 3, lastUsedAt: 1 } }, pluginUsage: {} }));
  });
  afterAll(() => {
    delete process.env.CTX_TEST_HOME;
    delete process.env.CTX_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('counts sessions, calls, subagents; skips measurement sessions and bad lines', async () => {
    const l = await buildLedger(root, { sessions: 10 });
    expect(l.sessions.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(l.sessionsScanned).toBe(3);
    expect(l.items['tool:Bash']).toEqual({ sessionsUsed: 1, calls: 2, lastUsedAt: '2026-11-01T10:05:00Z' });
    expect(l.items['tool:WebFetch']?.calls).toBe(1);
    expect(l.items['skill:docx']?.sessionsUsed).toBe(1);
    expect(l.items['skill:watch:watch']?.calls).toBe(1);
    expect(l.items['mcp:MCP_DOCKER']?.calls).toBe(1);
    expect(l.items['skill:context']).toBeUndefined();
    expect(l.global.skillUsage.docx?.usageCount).toBe(3);
  });

  it('respects the session window', async () => {
    const l = await buildLedger(root, { sessions: 1 });
    expect(l.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(l.items['tool:Bash']).toBeUndefined();
  });
});
