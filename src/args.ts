export interface Args { cmd: string; positional: string[]; flags: Record<string, string | true>; }

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  const valued = new Set(['only', 'sessions', 'plan', 'project', 'set', 'groups', 'reason', 'level', 'min-tokens']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (valued.has(a.slice(2)) && i + 1 < argv.length) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { cmd: positional.shift() ?? 'help', positional, flags };
}
