import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseContext, pluginOfSource, upfrontTotal } from '../src/parse.js';
import { fmtK, parseTokens } from '../src/tokens.js';

const fx = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

describe('parseTokens', () => {
  it.each([
    ['30.6k', 30600, '='], ['672', 672, '='], ['~120', 120, '~'], ['< 20', 20, '<'], ['1m', 1_000_000, '='],
    ['33k', 33000, '='], ['936.4k', 936400, '='], ['1,234', 1234, '='],
  ])('%s', (raw, tokens, q) => {
    expect(parseTokens(raw)).toEqual({ tokens, qualifier: q });
  });
  it('rejects junk', () => {
    expect(parseTokens('n/a')).toBeNull();
    expect(parseTokens('')).toBeNull();
  });
});

describe('fmtK', () => {
  it('formats', () => {
    expect(fmtK(16700)).toBe('16.7K');
    expect(fmtK(672)).toBe('672');
    expect(fmtK(12000)).toBe('12K');
    expect(fmtK(-4900)).toBe('-4.9K');
  });
});

describe('parseContext: Appendix A fixture', () => {
  const r = parseContext(fx('context-appendix-a.md'));
  it('reads headline', () => {
    expect(r.model).toBe('claude-opus-5-5');
    expect(r.totalTokens).toBe(30600);
    expect(r.windowTokens).toBe(1_000_000);
  });
  it('reads categories', () => {
    expect(r.categories['System tools']).toBe(18500);
    expect(r.categories['MCP tools']).toBe(672);
    expect(r.categories['Skills']).toBe(7300);
    expect(r.categories['System tools (deferred)']).toBe(20800);
  });
  it('reads tables', () => {
    expect(r.mcpTools).toHaveLength(2);
    expect(r.mcpTools[1]).toEqual({ tool: 'mcp__MCP_DOCKER__get_me', server: 'MCP_DOCKER', tokens: 106 });
    expect(r.memoryFiles[0]).toEqual({ type: 'User', path: 'C:\\Users\\Nev\\.claude\\CLAUDE.md', tokens: 215 });
    expect(r.skills.find((s) => s.name === 'dataviz')).toMatchObject({ source: 'Built-in', tokens: 480, qualifier: '~' });
    expect(pluginOfSource(r.skills.find((s) => s.name === 'cloudflare:wrangler')!.source)).toBe('cloudflare');
    expect(r.unparsed).toEqual([]);
  });
});

describe('parseContext: real 2.1.326 output', () => {
  it('untrimmed: 30.6K, 51 skills', () => {
    const r = parseContext(fx('context-2.1.326-untrimmed.md'));
    expect(r.totalTokens).toBe(30600);
    expect(r.categories['Skills']).toBe(7300);
    expect(r.skills.length).toBe(51);
    expect(r.memoryFiles.length).toBe(3);
  });
  it('lean: handles "< 20" values', () => {
    const r = parseContext(fx('context-2.1.326-lean.md'));
    expect(r.totalTokens).toBe(16700);
    expect(r.skills.find((s) => s.name === 'docx')).toMatchObject({ tokens: 20, qualifier: '<' });
  });
});

describe('parseContext: defensive', () => {
  it('missing sections and unknown sections', () => {
    const r = parseContext('## Context Usage\n\n**Tokens:** 1.2k / 200k (1%)\n\n### Something New\n\nhello\n');
    expect(r.totalTokens).toBe(1200);
    expect(r.skills).toEqual([]);
    expect(r.unparsed).toEqual([{ heading: 'Something New', body: 'hello' }]);
  });
  it('falls back to category sum without headline', () => {
    const r = parseContext(
      '### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|---|---|---|\n'
      + '| System prompt | 2k | 1% |\n| Skills | 500 | 0% |\n| Free space | 900k | 90% |\n');
    expect(r.totalTokens).toBeUndefined();
    expect(upfrontTotal(r)).toBe(2500);
  });
  it('CRLF and malformed rows', () => {
    const r = parseContext(
      '### Skills\r\n\r\n| Skill | Source | Tokens |\r\n|---|---|---|\r\n| a | User | ~30 |\r\n| broken row |\r\n| b | Built-in | weird |\r\n');
    expect(r.skills.map((s) => s.name)).toEqual(['a']);
  });
});
