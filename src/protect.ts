import fs from 'node:fs';
import path from 'node:path';
import { claudeDir } from './paths.js';
import type { Ledger } from './usage.js';

/** Spec §7.3. */
const ALWAYS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill', 'ToolSearch', 'AskUserQuestion', 'EndConversation'];

export interface ProtectOptions {
  ledger?: Ledger;
  /** Items pinned in project-profile.json "keep". */
  keep?: string[];
  /** Agent is protected unless the user unprotects it. */
  unprotectAgent?: boolean;
  platform?: NodeJS.Platform;
}

function claudeMdMentions(word: string): boolean {
  for (const f of [path.join(claudeDir(), 'CLAUDE.md')]) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      if (text.includes(word)) return true;
      // Follow one level of @includes (e.g. "@RTK.md").
      for (const m of text.matchAll(/^@(\S+)/gm)) {
        try { if (fs.readFileSync(path.resolve(path.dirname(f), m[1]), 'utf8').includes(word)) return true; } catch { /* missing */ }
      }
    } catch { /* missing */ }
  }
  return false;
}

export function protectedIds(opts: ProtectOptions = {}): Set<string> {
  const ids = new Set(ALWAYS.map((t) => `tool:${t}`));
  ids.add('tool:Bash');
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32' && ((opts.ledger?.items['tool:PowerShell']?.sessionsUsed ?? 0) > 0 || claudeMdMentions('PowerShell'))) {
    ids.add('tool:PowerShell');
  }
  if (!opts.unprotectAgent) ids.add('tool:Agent');
  // The plugin's own skills (model-invocable enable skill is listed as "ctx:enable").
  ids.add('skill:ctx:enable');
  for (const k of opts.keep ?? []) ids.add(k);
  return ids;
}
