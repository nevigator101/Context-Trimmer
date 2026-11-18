import { parseArgs } from './args.js';
import { renderDoctor } from './doctor.js';
import { loadMeasurement, measure } from './measure.js';
import { resolveProjectRoot } from './paths.js';
import { renderReport } from './report.js';
import { fmtK } from './tokens.js';
import { buildLedger, loadLedger } from './usage.js';

const HELP = `ctx: measure and trim what each Claude Code session loads.

Usage: ctx <command> [flags]
  measure [--full] [--only <id>] [--json]   measure upfront context (free; no model call)
  usage [--sessions N] [--json]             build the usage ledger from this project's transcripts
  report [--json]                           breakdown, what's off, usage, suggestions
  doctor                                    diagnose binary, settings, transcripts, cache
Global: --project <dir> (default: CLAUDE_PROJECT_DIR or cwd)
Coming in M2+: plan, apply, on, off, undo, hook, global`;

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const root = resolveProjectRoot(typeof a.flags.project === 'string' ? a.flags.project : undefined);
  const log = (s: string) => process.stderr.write(s + '\n');

  switch (a.cmd) {
    case 'measure': {
      const m = await measure(root, {
        full: !!a.flags.full,
        only: typeof a.flags.only === 'string' ? a.flags.only : undefined,
        log: a.flags.json ? undefined : log,
      });
      if (a.flags.json) { console.log(JSON.stringify(m, null, 2)); return 0; }
      const tools = Object.entries(m.items).filter(([id]) => id.startsWith('tool:')).sort((x, y) => y[1].deltaTokens - x[1].deltaTokens);
      const plugins = Object.entries(m.items).filter(([id]) => id.startsWith('plugin:'));
      console.log(`Untrimmed: ${fmtK(m.reference.correctedTokens)} · current: ${fmtK(m.current.correctedTokens)}` +
        (m.skillsQuirk ? ` (/context shows ${fmtK(m.current.totalTokens)})` : ''));
      console.log(`Tools (${m.toolDiscovery}): ` + tools.map(([id, it]) => `${id.slice(5)} ${it.unmeasured ? '?' : fmtK(it.deltaTokens)}`).join(' · '));
      if (plugins.length) console.log('Plugins: ' + plugins.map(([id, it]) => `${id.slice(7)} ${it.unmeasured ? '?' : fmtK(it.deltaTokens)}`).join(' · '));
      console.log(`Skills: ${m.skills.length} listed, ${fmtK(m.reference.categories['Skills'] ?? 0)} untrimmed`);
      return 0;
    }
    case 'usage': {
      const n = typeof a.flags.sessions === 'string' ? parseInt(a.flags.sessions, 10) : undefined;
      const l = await buildLedger(root, { sessions: n && n > 0 ? n : undefined });
      if (a.flags.json) { console.log(JSON.stringify(l, null, 2)); return 0; }
      console.log(`Scanned ${l.sessionsScanned} transcripts; ${l.sessions.length} sessions with assistant turns in the window.`);
      const top = Object.entries(l.items).sort((x, y) => y[1].sessionsUsed - x[1].sessionsUsed || y[1].calls - x[1].calls);
      for (const [id, u] of top.slice(0, 30)) console.log(`  ${id.padEnd(44)} ${String(u.sessionsUsed).padStart(3)} sessions ${String(u.calls).padStart(5)} calls  last ${u.lastUsedAt?.slice(0, 16) ?? '-'}`);
      return 0;
    }
    case 'report': {
      let m = loadMeasurement(root);
      if (!m) { log('No measurement yet; measuring now...'); m = await measure(root, { log }); }
      const l = loadLedger(root) ?? await buildLedger(root);
      if (a.flags.json) { console.log(JSON.stringify({ measurement: m, ledger: l }, null, 2)); return 0; }
      console.log(renderReport(root, m, l));
      return 0;
    }
    case 'doctor':
      console.log(renderDoctor(root));
      return 0;
    case 'help': case '--help': case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown or not yet implemented command: ${a.cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
  console.error(`ctx: ${(e as Error).message ?? String(e)}`);
  process.exitCode = 1;
});
