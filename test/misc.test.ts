import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { projectKey, transcriptSlug } from '../src/paths.js';
import { activeTrims, correctedCategories, wrapJoin } from '../src/report.js';
import { firstSentence } from '../src/runner.js';
import { isBareToolRule, stripTrimKeys } from '../src/settings.js';

describe('paths', () => {
  it('slug matches Claude Code', () => {
    if (process.platform === 'win32') {
      expect(transcriptSlug('c:\\Users\\Nev\\Observibility Proxy')).toBe('c--Users-Nev-Observibility-Proxy');
      expect(projectKey('C:\\Users\\Nev\\Observibility Proxy\\')).toBe('c:/Users/Nev/Observibility Proxy');
    } else {
      expect(transcriptSlug('/home/a/my.proj')).toBe('-home-a-my-proj');
    }
  });
});

describe('settings', () => {
  it('bare tool rules', () => {
    expect(isBareToolRule('Artifact')).toBe(true);
    expect(isBareToolRule('Bash(rm:*)')).toBe(false);
    expect(isBareToolRule('mcp__x__y')).toBe(false);
  });
  it('strips trim keys only', () => {
    const s = stripTrimKeys({
      permissions: { deny: ['Artifact', 'Bash(rm:*)'], allow: ['Read'] },
      enabledPlugins: { 'a@b': false, 'c@d': true },
      skillOverrides: { docx: 'name-only' },
      model: 'opus',
    });
    expect(s).toEqual({ permissions: { deny: ['Bash(rm:*)'], allow: ['Read'] }, enabledPlugins: { 'c@d': true }, model: 'opus' });
  });
  it('active trims with scopes; local wins for plugins', () => {
    const t = activeTrims([
      { scope: 'user', path: 'u', exists: true, data: { enabledPlugins: { 'x@m': true }, permissions: { deny: ['Agent'] } } },
      { scope: 'local', path: 'l', exists: true, data: { enabledPlugins: { 'x@m': false }, skillOverrides: { pdf: 'name-only', y: 'on' } } },
    ]);
    expect(t.tools).toEqual([{ name: 'Agent', scope: 'user' }]);
    expect(t.plugins).toEqual([{ id: 'x@m', scope: 'local' }]);
    expect(t.skills).toEqual([{ name: 'pdf', level: 'name-only', scope: 'local' }]);
  });
});

describe('report helpers', () => {
  it('quirk correction moves shifted skill tokens out of System tools', () => {
    const ref = { totalTokens: 30600, correctedTokens: 30600, categories: { 'System tools': 18500, Skills: 7300 } };
    const cur = { totalTokens: 16700, correctedTokens: 11800, categories: { 'System tools': 9800, Skills: 2400 } };
    expect(correctedCategories(cur, ref, true)['System tools']).toBe(4900);
    expect(correctedCategories(cur, ref, false)['System tools']).toBe(9800);
  });
  it('wraps at 100 columns', () => {
    const s = wrapJoin('Usage: ', Array.from({ length: 30 }, (_, i) => `item${i} 12`));
    for (const l of s.split('\n')) expect(l.length).toBeLessThanOrEqual(100);
  });
  it('first sentence', () => {
    expect(firstSentence('Publish a page. More text here.')).toBe('Publish a page.');
    expect(firstSentence('x'.repeat(200)).length).toBe(80);
  });
});

describe('args', () => {
  it('parses', () => {
    expect(parseArgs(['measure', '--full', '--only', 'tool:Bash', '--project=C:/x'])).toEqual({
      cmd: 'measure', positional: [], flags: { full: true, only: 'tool:Bash', project: 'C:/x' },
    });
  });
});
