import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseContext, type ContextReport } from './parse.js';

export interface RunSpec {
  /** Comma list for --setting-sources, e.g. "user,project". Omit to use all sources. */
  settingSources?: string;
  /** Extra settings JSON (flag layer). */
  settings?: Record<string, unknown>;
}

export interface RunResult { ok: boolean; report?: ContextReport; raw?: string; error?: string; ms: number; }

const TIMEOUT_MS = 120_000;

function buildArgs(spec: RunSpec, prompt: string, json: boolean): string[] {
  const args = ['-p', '--no-session-persistence'];
  if (json) args.push('--output-format', 'json');
  if (spec.settingSources) args.push('--setting-sources', spec.settingSources);
  if (spec.settings && Object.keys(spec.settings).length) args.push('--settings', JSON.stringify(spec.settings));
  args.push(prompt);
  return args;
}

function spawnCollect(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number):
  Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, {
      cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, MSYS_NO_PATHCONV: '1' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    p.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    p.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    const t = setTimeout(() => { timedOut = true; p.kill(); }, timeoutMs);
    p.on('error', (e) => { stderr += String(e); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/** Run `claude -p "/context"` once and parse it. */
export async function runContextOnce(bin: string, cwd: string, spec: RunSpec): Promise<RunResult> {
  const start = Date.now();
  const r = await spawnCollect(bin, buildArgs(spec, '/context', true), cwd, process.env, TIMEOUT_MS);
  const ms = Date.now() - start;
  if (r.timedOut) return { ok: false, error: 'timeout', ms };
  let md: string | undefined;
  try {
    const j = JSON.parse(r.stdout) as { result?: string; is_error?: boolean };
    if (j.is_error) return { ok: false, error: `claude reported an error: ${String(j.result).slice(0, 300)}`, ms };
    md = j.result;
  } catch {
    return { ok: false, error: `unparseable output (exit ${r.code}): ${(r.stdout + r.stderr).slice(0, 300)}`, ms };
  }
  if (!md) return { ok: false, error: 'empty result', ms };
  const report = parseContext(md);
  if (report.totalTokens === undefined && !Object.keys(report.categories).length) {
    return { ok: false, error: 'no /context data in output', raw: md, ms };
  }
  return { ok: true, report, raw: md, ms };
}

/** Run with one retry (spec §6.2). */
export async function runContext(bin: string, cwd: string, spec: RunSpec): Promise<RunResult> {
  const first = await runContextOnce(bin, cwd, spec);
  if (first.ok) return first;
  const second = await runContextOnce(bin, cwd, spec);
  return second.ok ? second : { ...second, error: `${first.error}; retry: ${second.error}` };
}

/** Run tasks with a concurrency limit (spec: at most 3 at a time). */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface CapturedRequest {
  tools: { name: string; deferred: boolean; chars: number; description: string }[];
  systemChars: number;
  messagesChars: number;
}

/**
 * Discover the exact upfront tool set by capturing the first API request (VERIFY.md items 6, 18).
 * ANTHROPIC_BASE_URL points at a local stub that records the body and answers HTTP 400, so no model call
 * is made and no quota is used. Returns null if capture is unavailable (e.g. Bedrock/Vertex setups).
 */
export async function captureRequest(bin: string, cwd: string, spec: RunSpec): Promise<CapturedRequest | null> {
  if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) return null;
  let body: string | undefined;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => { b += d; });
    req.on('end', () => {
      if (!body && req.url?.includes('/messages') && b.includes('"tools"')) body = b;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"ctx capture"}}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  try {
    const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
    await spawnCollect(bin, buildArgs(spec, 'hi', false), cwd, env, 60_000);
  } finally {
    srv.close();
  }
  if (!body) return null;
  try {
    const j = JSON.parse(body) as { system?: unknown; tools?: { name: string; defer_loading?: boolean; description?: string }[]; messages?: unknown };
    return {
      tools: (j.tools ?? []).map((t) => ({
        name: t.name, deferred: !!t.defer_loading, chars: JSON.stringify(t).length, description: firstSentence(t.description ?? ''),
      })),
      systemChars: JSON.stringify(j.system ?? '').length,
      messagesChars: JSON.stringify(j.messages ?? []).length,
    };
  } catch {
    return null;
  }
}

/** First sentence of a description, max 80 chars (capability index format, spec §9.1). */
export function firstSentence(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  const s = m ? m[1] : flat;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
