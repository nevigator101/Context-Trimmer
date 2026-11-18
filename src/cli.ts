import { parseArgs } from './args.js';
import { renderDoctor } from './doctor.js';
import { loadMeasurement, measure } from './measure.js';
import { resolveProjectRoot } from './paths.js';
import { renderReport } from './report.js';
import { fmtK } from './tokens.js';
import { buildLedger, loadLedger } from './usage.js';
import { allowEnable, apply, off, on, undo, verifyAndRecord } from './commands.js';
import { buildPlan, loadPlan, renderPlan, reviewPlan, savePlan, type Group } from './plan.js';
import { loadProfile, setProfile } from './profile.js';
import { protectedIds } from './protect.js';
import { offCandidates, promptSubmit, readHookInput, sessionEnd, sessionStart } from './hook.js';
import { applyGlobal, buildGlobalPlan, loadGlobalPlan, renderGlobalPlan, undoGlobal } from './global.js';
import { discoverProjects } from './registry.js';
import { DEFAULT_THRESHOLD, learnTriggers, loadConfig, loadTriggers, saveConfig, scorePrompt } from './triggers.js';

const GROUPS: Group[] = ['tools', 'plugins', 'skills', 'skills-off', 'rare'];
function parseGroups(v: string | true | undefined): Group[] | undefined {
  if (typeof v !== 'string') return undefined;
  const gs = v.split(/[,\s]+/).filter(Boolean);
  const bad = gs.filter((g) => !GROUPS.includes(g as Group));
  if (bad.length) throw new Error(`unknown group(s): ${bad.join(', ')} (valid: ${GROUPS.join(', ')})`);
  return gs as Group[];
}

const HELP = `ctx: measure and trim what each Claude Code session loads.

Usage: ctx <command> [flags]
  measure [--full] [--only <id>] [--json]   measure upfront context (free; no model call)
  usage [--sessions N] [--json]             build the usage ledger from this project's transcripts
  report [--json]                           breakdown, what's off, usage, suggestions
  doctor                                    diagnose binary, settings, transcripts, cache
  profile [--set '<json>']                  show or update the project description (summary, stack,
                                            services, workTypes, keep)
  plan [--aggressive] [--min-tokens N] [--json] [--set '<json>']
                                            propose a lean profile; --set applies Claude's review
                                            (it may only make the plan more conservative)
  apply [--groups g1,g2] [--yes] [--plan <file>] [--no-verify] [--git-exclude] [--allow-enable]
                                            write the plan to .claude/settings.local.json
                                            (groups: tools, plugins, skills, skills-off, rare;
                                            default: tools,plugins,skills; dry run without --yes)
  allow-enable [--remove]                   let Claude run /ctx:enable without a permission prompt
  on <item> [--force] [--reason "<task>"]   switch one item back on
  off <item> [--level name-only|off] [--force]   switch one item off
  undo [all]                                restore the previous backup, or the original file
  verify                                    one /context run of the current settings
  global [--days N] [--sessions N] [--share X] [--json]
                                            cross-project plan: extras used in few projects go off in
                                            ~/.claude/settings.json and stay on where they're used
  global apply [--items id1,id2] [--yes]    write it (dry run without --yes)
  global undo                               remove everything ctx global wrote
  projects                                  projects ctx knows (registry and transcripts)
  auto on|off|status [--threshold X]        learned triggers: switch items back on from prompt words
  triggers [learn] [--json] | triggers test "<prompt>"
                                            show, re-learn or try the trigger table
  hook session-start | session-end | prompt-submit
                                            hook entry points (cached data only)
Items: tool:Artifact, plugin:cloudflare@cloudflare, skill:docx, or just a name ("artifact").
Global: --project <dir> (default: CLAUDE_PROJECT_DIR or cwd)`;

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
      if (a.flags.quiet) return 0;
      if (a.flags.json) { console.log(JSON.stringify(l, null, 2)); return 0; }
      console.log(`Scanned ${l.sessionsScanned} transcripts; ${l.sessions.length} sessions with assistant turns in the window.`);
      const top = Object.entries(l.items).sort((x, y) => y[1].sessionsUsed - x[1].sessionsUsed || y[1].calls - x[1].calls);
      for (const [id, u] of top.slice(0, 30)) console.log(`  ${id.padEnd(44)} ${String(u.sessionsUsed).padStart(3)} sessions ${String(u.calls).padStart(5)} calls  last ${u.lastUsedAt?.slice(0, 16) ?? '-'}`);
      return 0;
    }
    case 'hook': {
      // Never fail a session because of ctx: swallow errors, always exit 0.
      try {
        const input = readHookInput();
        const hookRoot = resolveProjectRoot(typeof a.flags.project === 'string' ? a.flags.project : process.env.CLAUDE_PROJECT_DIR ?? input.cwd);
        if (a.positional[0] === 'session-start') {
          const out = sessionStart(hookRoot);
          if (out.systemMessage || out.hookSpecificOutput) process.stdout.write(JSON.stringify(out));
        } else if (a.positional[0] === 'session-end') {
          sessionEnd(hookRoot, process.argv[1]);
        } else if (a.positional[0] === 'prompt-submit') {
          const out = promptSubmit(hookRoot, input.prompt ?? '');
          if (out.systemMessage || out.hookSpecificOutput) process.stdout.write(JSON.stringify(out));
        }
      } catch (e) {
        if (process.env.CTX_DEBUG) console.error(e);
      }
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
    case 'profile': {
      if (typeof a.flags.set === 'string') {
        const p = setProfile(root, a.flags.set);
        console.log(JSON.stringify(p, null, 2));
        return 0;
      }
      const p = loadProfile(root);
      console.log(p ? JSON.stringify(p, null, 2) : `No project profile yet. Set one with: ctx profile --set '{"summary":"...","services":[],"workTypes":["code"]}'`);
      return 0;
    }
    case 'plan': {
      let m = loadMeasurement(root);
      if (!m) { log('No measurement yet; measuring now...'); m = await measure(root, { log }); }
      if (typeof a.flags.set === 'string') {
        const draft = loadPlan(root);
        if (!draft) { console.error('No plan to review. Run: ctx plan'); return 2; }
        const r = reviewPlan(draft, a.flags.set);
        savePlan(root, r.plan);
        for (const c of r.changed) console.log(`changed  ${c}`);
        for (const c of r.rejected) console.log(`rejected ${c}`);
        console.log(renderPlan(r.plan, m));
        return r.rejected.length ? 1 : 0;
      }
      const l = loadLedger(root) ?? await buildLedger(root);
      const profile = loadProfile(root);
      const minTokens = typeof a.flags['min-tokens'] === 'string' ? parseInt(a.flags['min-tokens'], 10) : undefined;
      const plan = buildPlan(m, l, profile, {
        aggressive: !!a.flags.aggressive,
        minTokens: minTokens && minTokens > 0 ? minTokens : undefined,
        protectedIds: protectedIds({ ledger: l, keep: profile?.keep }),
      });
      savePlan(root, plan);
      console.log(a.flags.json ? JSON.stringify(plan, null, 2) : renderPlan(plan, m));
      return 0;
    }
    case 'apply':
      return apply(root, {
        groups: parseGroups(a.flags.groups),
        yes: !!a.flags.yes,
        planFile: typeof a.flags.plan === 'string' ? a.flags.plan : undefined,
        verify: !a.flags['no-verify'],
        gitExclude: !!a.flags['git-exclude'],
        allowEnable: !!a.flags['allow-enable'],
      }, (s) => console.log(s));
    case 'allow-enable':
      return allowEnable(root, !!a.flags.remove, (s) => console.log(s));
    case 'on':
    case 'off': {
      const q = a.positional.join(' ').trim();
      if (!q) { console.error(`Usage: ctx ${a.cmd} <item>`); return 2; }
      const out = (s: string) => console.log(s);
      if (a.cmd === 'on') return on(root, q, { force: !!a.flags.force, reason: typeof a.flags.reason === 'string' ? a.flags.reason : undefined }, out);
      const level = a.flags.level === 'off' ? 'off' : 'name-only';
      return off(root, q, { force: !!a.flags.force, level }, out);
    }
    case 'undo':
      return undo(root, a.positional[0] === 'all', (s) => console.log(s));
    case 'verify': {
      const m = loadMeasurement(root);
      if (!m) { console.error('No measurement yet. Run: ctx measure'); return 2; }
      await verifyAndRecord(root, m, (s) => console.log(s));
      return 0;
    }
    case 'doctor':
      console.log(renderDoctor(root));
      return 0;
    case 'global': {
      const sub = a.positional[0] ?? 'plan';
      const out = (s: string) => console.log(s);
      if (sub === 'undo') return undoGlobal(out);
      if (sub === 'apply') {
        const plan = loadGlobalPlan();
        if (!plan) { console.error('No global plan yet. Run: ctx global'); return 2; }
        const items = typeof a.flags.items === 'string' ? a.flags.items.split(/[,\s]+/).filter(Boolean) : undefined;
        return applyGlobal(plan, { yes: !!a.flags.yes, items }, out);
      }
      if (sub !== 'plan') { console.error(`Unknown: ctx global ${sub} (plan, apply, undo)`); return 2; }
      const num = (k: string) => (typeof a.flags[k] === 'string' ? Number(a.flags[k]) : undefined);
      const plan = await buildGlobalPlan({ days: num('days'), sessions: num('sessions'), share: num('share'), minTokens: num('min-tokens') });
      console.log(a.flags.json ? JSON.stringify(plan, null, 2) : renderGlobalPlan(plan));
      return 0;
    }
    case 'projects': {
      const ps = await discoverProjects();
      for (const p of ps) {
        console.log(`${p.key.padEnd(56).slice(0, 56)} ${String(p.sessions).padStart(4)} sessions  last ${p.lastActive?.slice(0, 10) ?? '-'.padEnd(10)}`
          + `${p.registered ? '  profiled' : ''}${p.exists ? '' : '  (folder gone)'}`);
      }
      return 0;
    }
    case 'auto': {
      const sub = a.positional[0] ?? 'status';
      const cfg = loadConfig();
      if (typeof a.flags.threshold === 'string') {
        const t = Number(a.flags.threshold);
        if (!(t > 0 && t <= 1)) { console.error('--threshold must be between 0 and 1'); return 2; }
        cfg.threshold = t;
      }
      if (sub === 'on' || sub === 'off') {
        cfg.auto = sub === 'on';
        saveConfig(cfg);
        if (cfg.auto) {
          const t = await learnTriggers(await discoverProjects());
          console.log(`Auto re-enable is on. Learned triggers from ${t.prompts} prompts in ${t.sessions} sessions.`);
          console.log('When a prompt clearly needs a switched-off item, ctx switches it back on before Claude sees the prompt.');
        } else {
          console.log('Auto re-enable is off. Claude can still use /ctx:enable, and you can use /ctx:on.');
        }
        return 0;
      }
      if (sub !== 'status') { console.error('Usage: ctx auto on|off|status'); return 2; }
      if (typeof a.flags.threshold === 'string') saveConfig(cfg);
      const t = loadTriggers();
      console.log(`Auto re-enable: ${cfg.auto ? 'on' : 'off'} (threshold ${cfg.threshold ?? DEFAULT_THRESHOLD})`);
      console.log(t ? `Triggers learned ${t.learnedAt.slice(0, 16).replace('T', ' ')} UTC from ${t.prompts} prompts.` : 'No triggers learned yet.');
      const cands = offCandidates(root);
      if (cands.length) {
        console.log('Switched off here, with the words that switch each back on:');
        for (const id of cands) {
          const kws = t?.items[id]?.keywords ?? [];
          console.log(`  ${id.padEnd(36)} ${kws.length ? kws.slice(0, 8).map((k) => k.word).join(', ') : '(no triggers; use /ctx:on)'}`.slice(0, 100));
        }
      } else {
        console.log('Nothing ctx switched off in this project.');
      }
      return 0;
    }
    case 'triggers': {
      const sub = a.positional[0];
      if (sub === 'learn') {
        const t = await learnTriggers(await discoverProjects());
        if (!a.flags.quiet) console.log(`Learned triggers for ${Object.keys(t.items).length} items from ${t.prompts} prompts in ${t.sessions} sessions.`);
        return 0;
      }
      const t = loadTriggers();
      if (!t) { console.log('No triggers learned yet. Run: ctx triggers learn'); return 0; }
      if (sub === 'test') {
        const prompt = a.positional.slice(1).join(' ');
        const ids = Object.keys(t.items);
        const ms = scorePrompt(prompt, ids, t, 0);
        const thr = loadConfig().threshold ?? DEFAULT_THRESHOLD;
        if (!ms.length) console.log('No item matches.');
        for (const m of ms.slice(0, 10)) console.log(`${m.score >= thr ? 'ON ' : '   '} ${m.id.padEnd(36)} ${m.score.toFixed(2)}  ${m.words.join(', ')}`);
        return 0;
      }
      if (a.flags.json) { console.log(JSON.stringify(t, null, 2)); return 0; }
      for (const [id, it] of Object.entries(t.items).sort((x, y) => y[1].prompts - x[1].prompts)) {
        console.log(`${id.padEnd(36)} ${String(it.prompts).padStart(4)} prompts  ${it.keywords.slice(0, 6).map((k) => `${k.word}${k.source === 'learned' ? ` ${k.weight}` : ''}`).join(', ')}`.slice(0, 100));
      }
      return 0;
    }
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
