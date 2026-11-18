import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  atomicWrite, clearEntry, listBackups, loadApplied, setEntry, undo, writeSettings, type EntryRef,
} from '../src/writer.js';

let root: string;
let state: string;
const file = () => path.join(root, '.claude', 'settings.local.json');
const bytes = () => (fs.existsSync(file()) ? fs.readFileSync(file()) : null);
const write = (s: string) => { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), s); };
const json = () => JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, any>;
const apply = (refs: EntryRef[]) => writeSettings(root, 'test', (s, a) => refs.map((r) => setEntry(s, a, r)).filter((c): c is string => !!c));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx proj '));
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-state-'));
  process.env.CTX_HOME = state;
});
afterEach(() => {
  delete process.env.CTX_HOME;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

describe('writeSettings: merge and ownership', () => {
  it('creates .claude/ and the file when absent; undo all deletes it', () => {
    const r = apply([{ kind: 'tool', name: 'Artifact' }]);
    expect(r.changes).toEqual(['deny Artifact']);
    expect(json()).toEqual({ permissions: { deny: ['Artifact'] } });
    expect(loadApplied(root).owned.deny).toEqual(['Artifact']);
    undo(root, true);
    expect(bytes()).toBeNull();
  });

  it('keeps unrelated keys, key order and formatting style', () => {
    const original = '{\r\n    "model": "opus",\r\n    "permissions": {\r\n        "allow": ["Read"],\r\n        "deny": ["Bash(rm:*)"]\r\n    }\r\n}\r\n';
    write(original);
    apply([{ kind: 'tool', name: 'Artifact' }, { kind: 'skill', name: 'docx', level: 'name-only' }]);
    const text = fs.readFileSync(file(), 'utf8');
    expect(text).toContain('\r\n    "model": "opus"');
    expect(text.endsWith('\r\n')).toBe(true);
    expect(json()).toEqual({
      model: 'opus', permissions: { allow: ['Read'], deny: ['Bash(rm:*)', 'Artifact'] }, skillOverrides: { docx: 'name-only' },
    });
    expect(Object.keys(json())).toEqual(['model', 'permissions', 'skillOverrides']);
  });

  it('records preexisting entries and never removes them', () => {
    write(JSON.stringify({ permissions: { deny: ['ScheduleWakeup'] }, enabledPlugins: { 'c@c': false } }));
    const r = apply([{ kind: 'tool', name: 'ScheduleWakeup' }, { kind: 'plugin', id: 'c@c' }]);
    expect(r.changes).toEqual([]);
    expect(r.backup).toBe('');
    const a = loadApplied(root);
    expect(a.owned.deny).toEqual([]);
    const s = json();
    expect(clearEntry(s, a, { kind: 'tool', name: 'ScheduleWakeup' })).toBe('not-owned');
    expect(clearEntry(s, a, { kind: 'plugin', id: 'c@c' })).toBe('not-owned');
    expect(s.permissions.deny).toEqual(['ScheduleWakeup']);
  });

  it("doesn't change a value the user set", () => {
    write(JSON.stringify({ skillOverrides: { pdf: 'user-invocable-only' }, enabledPlugins: { 'w@m': true } }));
    const r = apply([{ kind: 'skill', name: 'pdf', level: 'name-only' }, { kind: 'plugin', id: 'w@m' }]);
    expect(r.changes.every((c) => c.startsWith('skipped'))).toBe(true);
    expect(json()).toEqual({ skillOverrides: { pdf: 'user-invocable-only' }, enabledPlugins: { 'w@m': true } });
  });

  it('removing an owned entry cleans up empty containers', () => {
    write('{"model":"opus"}');
    apply([{ kind: 'tool', name: 'Artifact' }]);
    writeSettings(root, 'on', (s, a) => (clearEntry(s, a, { kind: 'tool', name: 'Artifact' }) === 'removed' ? ['on'] : []));
    expect(json()).toEqual({ model: 'opus' });
    expect(loadApplied(root).owned.deny).toEqual([]);
  });
});

describe('backup and undo', () => {
  it('undo restores each previous state byte for byte; undo all restores the original', () => {
    const original = '{\n  "model":   "opus"  ,"x": [1,2]\n}';
    write(original);
    apply([{ kind: 'tool', name: 'Artifact' }]);
    const afterFirst = bytes()!;
    apply([{ kind: 'skill', name: 'docx', level: 'name-only' }]);
    expect(json().skillOverrides).toEqual({ docx: 'name-only' });
    undo(root);
    expect(bytes()!.equals(afterFirst)).toBe(true);
    expect(loadApplied(root).owned.skills).toEqual({});
    expect(loadApplied(root).owned.deny).toEqual(['Artifact']);
    undo(root);
    expect(bytes()!.toString('utf8')).toBe(original);
    apply([{ kind: 'tool', name: 'Agent' }]);
    undo(root, true);
    expect(bytes()!.toString('utf8')).toBe(original);
    expect(loadApplied(root).owned.deny).toEqual([]);
  });

  it('saves manual edits before undo overwrites them', () => {
    write('{}');
    apply([{ kind: 'tool', name: 'Artifact' }]);
    write('{"permissions":{"deny":["Artifact"]},"permissions2":1}');
    const r = undo(root);
    expect(r.manualEditsSaved).toBeTruthy();
    expect(bytes()!.toString()).toBe('{}');
  });

  it('keeps the original plus the last 20 backups', () => {
    write('{"orig":true}');
    const tools = Array.from({ length: 25 }, (_, i) => `T${i}`);
    for (const t of tools) apply([{ kind: 'tool', name: t }]);
    expect(listBackups(root).length).toBe(21);
    undo(root, true);
    expect(bytes()!.toString()).toBe('{"orig":true}');
  });
});

describe('failure handling', () => {
  it('refuses to overwrite invalid JSON', () => {
    write('{ not json');
    expect(() => apply([{ kind: 'tool', name: 'Artifact' }])).toThrow(/not valid JSON/);
    expect(bytes()!.toString()).toBe('{ not json');
  });

  it('retries rename and succeeds after transient failures', () => {
    const target = path.join(root, 'f.json');
    let calls = 0;
    atomicWrite(target, '{"a":1}', {
      renameSync: (a, b) => { calls++; if (calls < 3) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); fs.renameSync(a, b); },
    });
    expect(calls).toBe(3);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
  });

  it('restores the original when the write keeps failing', () => {
    write('{"model":"opus"}');
    const failing = { renameSync: () => { throw Object.assign(new Error('EPERM locked'), { code: 'EPERM' }); } };
    expect(() => writeSettings(root, 't', (s, a) => [setEntry(s, a, { kind: 'tool', name: 'X' })!], failing as never)).toThrow(/original restored/);
    expect(bytes()!.toString()).toBe('{"model":"opus"}');
    expect(fs.existsSync(`${file()}.tmp`)).toBe(false);
  });
});
