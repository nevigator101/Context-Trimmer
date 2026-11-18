import { parseTokens, type TokenValue } from './tokens.js';

export interface ContextSkill { name: string; source: string; tokens: number; qualifier: TokenValue['qualifier']; }
export interface ContextMcpTool { tool: string; server: string; tokens: number; }
export interface ContextMemoryFile { type: string; path: string; tokens: number; }

export interface ContextReport {
  model?: string;
  totalTokens?: number;
  windowTokens?: number;
  categories: Record<string, number>;
  skills: ContextSkill[];
  mcpTools: ContextMcpTool[];
  memoryFiles: ContextMemoryFile[];
  /** Sections the parser did not understand, kept verbatim. */
  unparsed: { heading: string; body: string }[];
}

/** Categories that /context lists but that are not part of the upfront headline total. */
export const NON_UPFRONT = new Set([
  'MCP tools (deferred)', 'System tools (deferred)', 'Free space', 'Autocompact buffer',
]);

interface Section { heading: string; level: number; lines: string[]; }

function splitSections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { heading: '', level: 0, lines: [] };
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const h = line.match(/^(#{2,4})\s+(.*?)\s*$/);
    if (h) {
      out.push(cur);
      cur = { heading: h[2], level: h[1].length, lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  out.push(cur);
  return out;
}

/** Rows of the first Markdown table in `lines`, header and separator removed. */
function tableRows(lines: string[]): string[][] {
  const rows: string[][] = [];
  let seenSep = false;
  let started = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|')) {
      if (started) break;
      continue;
    }
    started = true;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) { seenSep = true; continue; }
    if (!seenSep) continue; // header row
    rows.push(cells);
  }
  return rows;
}

export function parseContext(md: string): ContextReport {
  const report: ContextReport = { categories: {}, skills: [], mcpTools: [], memoryFiles: [], unparsed: [] };

  const model = md.match(/\*\*Model:\*\*\s*([^\s*]+)/);
  if (model) report.model = model[1];
  const tot = md.match(/\*\*Tokens:\*\*\s*([^\s/]+)\s*\/\s*([^\s(]+)/);
  if (tot) {
    report.totalTokens = parseTokens(tot[1])?.tokens;
    report.windowTokens = parseTokens(tot[2])?.tokens;
  }

  for (const sec of splitSections(md)) {
    const name = sec.heading.toLowerCase();
    if (sec.level === 0 || name === 'context usage') continue;
    const rows = tableRows(sec.lines);
    if (name.startsWith('estimated usage by category')) {
      for (const r of rows) {
        const v = r[1] !== undefined ? parseTokens(r[1]) : null;
        if (r[0] && v) report.categories[r[0]] = v.tokens;
      }
    } else if (name === 'skills') {
      for (const r of rows) {
        const v = r[2] !== undefined ? parseTokens(r[2]) : null;
        if (r[0] && v) report.skills.push({ name: r[0], source: r[1] ?? '', tokens: v.tokens, qualifier: v.qualifier });
      }
    } else if (name === 'mcp tools') {
      for (const r of rows) {
        const v = r[2] !== undefined ? parseTokens(r[2]) : null;
        if (r[0] && v) report.mcpTools.push({ tool: r[0], server: r[1] ?? '', tokens: v.tokens });
      }
    } else if (name === 'memory files') {
      for (const r of rows) {
        const v = r[2] !== undefined ? parseTokens(r[2]) : null;
        if (r[1] && v) report.memoryFiles.push({ type: r[0] ?? '', path: r[1], tokens: v.tokens });
      }
    } else {
      const body = sec.lines.join('\n').trim();
      if (body) report.unparsed.push({ heading: sec.heading, body });
    }
  }
  return report;
}

/** Sum of upfront categories; used when the headline total is missing. */
export function upfrontTotal(r: ContextReport): number {
  if (r.totalTokens !== undefined) return r.totalTokens;
  return Object.entries(r.categories).filter(([k]) => !NON_UPFRONT.has(k)).reduce((a, [, v]) => a + v, 0);
}

/** Plugin name from a skill source like "Plugin (cloudflare)". */
export function pluginOfSource(source: string): string | undefined {
  return source.match(/^Plugin \((.+)\)$/)?.[1];
}
