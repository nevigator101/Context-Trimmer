import fs from 'node:fs';
import { candidates, findClaude } from './binary.js';
import { runtimeLabel } from './self.js';
import { fingerprint, loadMeasurement, measurementPath } from './measure.js';
import { claudeJsonPath, ctxHome, projectKey, projectStateDir, readJson, transcriptDirs } from './paths.js';
import { loadScopes } from './settings.js';
import { ledgerPath, loadLedger } from './usage.js';
import { driftedEntries, loadApplied, ownedRefs } from './writer.js';

/** Is the ctx profile in force? Compares applied.json's owned entries with the actual file. */
export function profileStatus(root: string): string {
  const a = loadApplied(root);
  const owned = ownedRefs(a).length;
  const pre = a.preexisting.deny.length + Object.keys(a.preexisting.plugins).length + Object.keys(a.preexisting.skills).length;
  if (!owned && !a.history.length) return 'not applied (run /ctx:setup)';
  const local = loadScopes(root).find((s) => s.scope === 'local');
  if (local?.error) return `settings.local.json is INVALID (${local.error}); ctx entries can't be checked`;
  const drift = driftedEntries(local?.data ?? {}, a);
  const last = a.history.at(-1);
  const parts = [`${owned} entries owned by ctx`, `${pre} preexisting`];
  if (last) parts.push(`last change: ${last.action}, ${age(last.at)}`);
  if (a.verified) parts.push(`verified ${(a.verified.beforeTokens / 1000).toFixed(1)}K -> ${(a.verified.afterTokens / 1000).toFixed(1)}K`);
  parts.push(drift.length ? `DRIFT: ${drift.join(', ')} changed outside ctx` : 'in force');
  return parts.join('; ');
}

function age(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

export function renderDoctor(root: string): string {
  const out: string[] = [];
  out.push(`ctx doctor: ${projectKey(root)}`);
  out.push(`  runtime: ${runtimeLabel()} on ${process.platform}-${process.arch}`);

  const bin = findClaude();
  if (bin) out.push(`  claude binary: ${bin.path}  (v${bin.version}, via ${bin.source})`);
  else {
    out.push('  claude binary: NOT FOUND. Set CTX_CLAUDE_BIN to the full path of claude(.exe). Checked:');
    for (const c of candidates()) out.push(`    - ${c.path} (${c.source})${fs.existsSync(c.path) ? ' [exists, --version failed]' : ''}`);
  }

  out.push('  settings files:');
  const scopes = loadScopes(root);
  for (const s of scopes) {
    const state = !s.exists ? 'absent' : s.error ? `INVALID: ${s.error}` : 'ok';
    out.push(`    ${s.scope.padEnd(8)} ${s.path}  [${state}]`);
  }

  const dirs = transcriptDirs(root);
  out.push(`  transcript dirs: ${dirs.length ? '' : 'none found'}`);
  for (const d of dirs) {
    const n = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).length;
    out.push(`    ${d}  (${n} sessions)`);
  }

  const cj = readJson<{ projects?: Record<string, { disabledMcpServers?: string[] }> }>(claudeJsonPath());
  const pe = cj?.projects?.[projectKey(root)];
  out.push(`  ~/.claude.json project entry: ${pe ? 'found' : 'not found'}${pe?.disabledMcpServers?.length ? ` (disabled MCP: ${pe.disabledMcpServers.join(', ')})` : ''}`);

  out.push(`  state dir: ${projectStateDir(root)}`);
  const m = loadMeasurement(root);
  if (m) {
    const fresh = bin ? (fingerprint(root, scopes, bin.version) === m.fingerprint ? 'current' : 'STALE (settings or version changed)') : 'unknown';
    out.push(`  measurement: ${age(m.measuredAt)}, Claude Code ${m.ccVersion}, ${fresh}; tool list via ${m.toolDiscovery}; skills quirk ${m.skillsQuirk ? 'on' : 'off'}`);
    if (m.unparsed.length) out.push(`  /context sections not parsed: ${m.unparsed.join(', ')}`);
  } else {
    out.push(`  measurement: none (${measurementPath(root)})`);
  }
  const l = loadLedger(root);
  out.push(l ? `  usage ledger: ${age(l.builtAt)}, ${l.sessions.length} sessions` : `  usage ledger: none (${ledgerPath(root)})`);
  out.push(`  profile: ${profileStatus(root)}`);
  out.push(`  ctx home: ${ctxHome()}`);
  return out.join('\n');
}
