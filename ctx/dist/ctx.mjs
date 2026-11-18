#!/usr/bin/env node

// src/args.ts
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const valued = /* @__PURE__ */ new Set(["only", "sessions", "plan", "project", "set", "groups", "reason"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (valued.has(a.slice(2)) && i + 1 < argv.length) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { cmd: positional.shift() ?? "help", positional, flags };
}

// src/doctor.ts
import fs6 from "node:fs";

// src/binary.ts
import { spawnSync } from "node:child_process";
import fs2 from "node:fs";
import path2 from "node:path";

// src/paths.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
function homeDir() {
  return process.env.CTX_TEST_HOME ?? os.homedir();
}
function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homeDir(), ".claude");
}
function claudeJsonPath() {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(homeDir(), ".claude.json");
}
function ctxHome() {
  return process.env.CTX_HOME ?? path.join(claudeDir(), "ctx");
}
function resolveProjectRoot(flag) {
  return path.resolve(flag ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
}
function projectKey(root) {
  let p = path.resolve(root).replace(/\\/g, "/");
  p = p.replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`);
  if (p.length > 3) p = p.replace(/\/+$/, "");
  return p;
}
function projectHash(root) {
  return createHash("sha256").update(projectKey(root).toLowerCase()).digest("hex").slice(0, 16);
}
function projectStateDir(root) {
  return path.join(ctxHome(), "projects", projectHash(root));
}
function transcriptSlug(root) {
  return path.resolve(root).replace(/[^A-Za-z0-9]/g, "-");
}
function transcriptDirs(root) {
  const base = path.join(claudeDir(), "projects");
  const want = transcriptSlug(root).toLowerCase();
  try {
    return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.toLowerCase() === want).map((d) => path.join(base, d.name));
  } catch {
    return [];
  }
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return void 0;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// src/binary.ts
function tryVersion(bin) {
  try {
    const r = spawnSync(bin, ["--version"], {
      shell: false,
      encoding: "utf8",
      timeout: 15e3,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    if (r.status !== 0) return void 0;
    return r.stdout.match(/(\d+\.\d+\.\d+)/)?.[1];
  } catch {
    return void 0;
  }
}
function newestVsCodeBinary(exe) {
  const roots = [".vscode", ".vscode-insiders", ".cursor", ".windsurf"].map((d) => path2.join(homeDir(), d, "extensions"));
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs2.readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const m = e.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
      if (!m) continue;
      const p = path2.join(root, e, "resources", "native-binary", exe);
      if (fs2.existsSync(p)) found.push({ p, v: [Number(m[1]), Number(m[2]), Number(m[3])] });
    }
  }
  found.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return found.map((f) => f.p);
}
function candidates() {
  const win = process.platform === "win32";
  const out = [];
  if (process.env.CTX_CLAUDE_BIN) out.push({ path: process.env.CTX_CLAUDE_BIN, source: "CTX_CLAUDE_BIN" });
  if (process.env.CLAUDE_CODE_EXECPATH) out.push({ path: process.env.CLAUDE_CODE_EXECPATH, source: "CLAUDE_CODE_EXECPATH" });
  const exts = win ? [".exe", ".cmd"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path2.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path2.join(dir, `claude${ext}`);
      if (fs2.existsSync(p)) out.push({ path: p, source: "PATH" });
    }
  }
  const h = homeDir();
  if (win) {
    out.push({ path: path2.join(h, ".local", "bin", "claude.exe"), source: "install" });
    if (process.env.APPDATA) out.push({ path: path2.join(process.env.APPDATA, "npm", "claude.cmd"), source: "npm" });
    for (const p of newestVsCodeBinary("claude.exe")) out.push({ path: p, source: "vscode-extension" });
  } else {
    out.push({ path: path2.join(h, ".local", "bin", "claude"), source: "install" });
    out.push({ path: path2.join(h, ".claude", "local", "claude"), source: "install" });
    for (const p of newestVsCodeBinary("claude")) out.push({ path: p, source: "vscode-extension" });
  }
  return out;
}
var cached;
function findClaude() {
  if (cached !== void 0) return cached;
  const seen = /* @__PURE__ */ new Set();
  for (const c of candidates()) {
    const key = c.path.toLowerCase();
    if (seen.has(key) || !fs2.existsSync(c.path)) continue;
    seen.add(key);
    if (c.path.toLowerCase().endsWith(".cmd")) continue;
    const version = tryVersion(c.path);
    if (version) return cached = { path: c.path, version, source: c.source };
  }
  return cached = null;
}

// src/measure.ts
import { createHash as createHash2 } from "node:crypto";
import fs4 from "node:fs";
import path4 from "node:path";

// src/tokens.ts
function parseTokens(raw) {
  const s = raw.trim().replace(/,/g, "");
  const m = s.match(/^(<|~)?\s*(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!m) return null;
  const n = parseFloat(m[2]);
  const mult = m[3] ? m[3].toLowerCase() === "k" ? 1e3 : 1e6 : 1;
  return { tokens: Math.round(n * mult), qualifier: m[1] ?? "=" };
}
function fmtK(tokens) {
  const sign = tokens < 0 ? "-" : "";
  const t = Math.abs(tokens);
  if (t < 1e3) return `${sign}${Math.round(t)}`;
  if (t < 1e6) return `${sign}${(t / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return `${sign}${(t / 1e6).toFixed(2).replace(/0$/, "")}M`;
}
function fmtK1(tokens) {
  return `${(tokens / 1e3).toFixed(1)}K`;
}

// src/parse.ts
function splitSections(md) {
  const out = [];
  let cur = { heading: "", level: 0, lines: [] };
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
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
function tableRows(lines) {
  const rows = [];
  let seenSep = false;
  let started = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      if (started) break;
      continue;
    }
    started = true;
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) {
      seenSep = true;
      continue;
    }
    if (!seenSep) continue;
    rows.push(cells);
  }
  return rows;
}
function parseContext(md) {
  const report = { categories: {}, skills: [], mcpTools: [], memoryFiles: [], unparsed: [] };
  const model = md.match(/\*\*Model:\*\*\s*([^\s*]+)/);
  if (model) report.model = model[1];
  const tot = md.match(/\*\*Tokens:\*\*\s*([^\s/]+)\s*\/\s*([^\s(]+)/);
  if (tot) {
    report.totalTokens = parseTokens(tot[1])?.tokens;
    report.windowTokens = parseTokens(tot[2])?.tokens;
  }
  for (const sec of splitSections(md)) {
    const name = sec.heading.toLowerCase();
    if (sec.level === 0 || name === "context usage") continue;
    const rows = tableRows(sec.lines);
    if (name.startsWith("estimated usage by category")) {
      for (const r of rows) {
        const v = r[1] !== void 0 ? parseTokens(r[1]) : null;
        if (r[0] && v) report.categories[r[0]] = v.tokens;
      }
    } else if (name === "skills") {
      for (const r of rows) {
        const v = r[2] !== void 0 ? parseTokens(r[2]) : null;
        if (r[0] && v) report.skills.push({ name: r[0], source: r[1] ?? "", tokens: v.tokens, qualifier: v.qualifier });
      }
    } else if (name === "mcp tools") {
      for (const r of rows) {
        const v = r[2] !== void 0 ? parseTokens(r[2]) : null;
        if (r[0] && v) report.mcpTools.push({ tool: r[0], server: r[1] ?? "", tokens: v.tokens });
      }
    } else if (name === "memory files") {
      for (const r of rows) {
        const v = r[2] !== void 0 ? parseTokens(r[2]) : null;
        if (r[1] && v) report.memoryFiles.push({ type: r[0] ?? "", path: r[1], tokens: v.tokens });
      }
    } else {
      const body = sec.lines.join("\n").trim();
      if (body) report.unparsed.push({ heading: sec.heading, body });
    }
  }
  return report;
}
function pluginOfSource(source) {
  return source.match(/^Plugin \((.+)\)$/)?.[1];
}

// src/runner.ts
import { spawn } from "node:child_process";
import http from "node:http";
var TIMEOUT_MS = 12e4;
function buildArgs(spec, prompt, json) {
  const args = ["-p", "--no-session-persistence"];
  if (json) args.push("--output-format", "json");
  if (spec.settingSources) args.push("--setting-sources", spec.settingSources);
  if (spec.settings && Object.keys(spec.settings).length) args.push("--settings", JSON.stringify(spec.settings));
  args.push(prompt);
  return args;
}
function spawnCollect(bin, args, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, MSYS_NO_PATHCONV: "1" }
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    p.stdout.setEncoding("utf8").on("data", (d) => {
      stdout += d;
    });
    p.stderr.setEncoding("utf8").on("data", (d) => {
      stderr += d;
    });
    const t = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, timeoutMs);
    p.on("error", (e) => {
      stderr += String(e);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
async function runContextOnce(bin, cwd, spec) {
  const start = Date.now();
  const r = await spawnCollect(bin, buildArgs(spec, "/context", true), cwd, process.env, TIMEOUT_MS);
  const ms = Date.now() - start;
  if (r.timedOut) return { ok: false, error: "timeout", ms };
  let md;
  try {
    const j = JSON.parse(r.stdout);
    if (j.is_error) return { ok: false, error: `claude reported an error: ${String(j.result).slice(0, 300)}`, ms };
    md = j.result;
  } catch {
    return { ok: false, error: `unparseable output (exit ${r.code}): ${(r.stdout + r.stderr).slice(0, 300)}`, ms };
  }
  if (!md) return { ok: false, error: "empty result", ms };
  const report = parseContext(md);
  if (report.totalTokens === void 0 && !Object.keys(report.categories).length) {
    return { ok: false, error: "no /context data in output", raw: md, ms };
  }
  return { ok: true, report, raw: md, ms };
}
async function runContext(bin, cwd, spec) {
  const first = await runContextOnce(bin, cwd, spec);
  if (first.ok) return first;
  const second = await runContextOnce(bin, cwd, spec);
  return second.ok ? second : { ...second, error: `${first.error}; retry: ${second.error}` };
}
async function pool(items, limit, fn) {
  const out = new Array(items.length);
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
async function captureRequest(bin, cwd, spec) {
  if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) return null;
  let body;
  const srv = http.createServer((req, res) => {
    let b = "";
    req.setEncoding("utf8");
    req.on("data", (d) => {
      b += d;
    });
    req.on("end", () => {
      if (!body && req.url?.includes("/messages") && b.includes('"tools"')) body = b;
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"ctx capture"}}');
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = srv.address().port;
  try {
    const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
    await spawnCollect(bin, buildArgs(spec, "hi", false), cwd, env, 6e4);
  } finally {
    srv.close();
  }
  if (!body) return null;
  try {
    const j = JSON.parse(body);
    return {
      tools: (j.tools ?? []).map((t) => ({
        name: t.name,
        deferred: !!t.defer_loading,
        chars: JSON.stringify(t).length,
        description: firstSentence(t.description ?? "")
      })),
      systemChars: JSON.stringify(j.system ?? "").length,
      messagesChars: JSON.stringify(j.messages ?? []).length
    };
  } catch {
    return null;
  }
}
function firstSentence(text, max = 80) {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  const s = m ? m[1] : flat;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "\u2026" : s;
}

// src/settings.ts
import fs3 from "node:fs";
import path3 from "node:path";
function managedSettingsPath() {
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}
function localSettingsPath(root) {
  return path3.join(root, ".claude", "settings.local.json");
}
function load(scope, file) {
  if (!fs3.existsSync(file)) return { scope, path: file, exists: false };
  try {
    const data = JSON.parse(fs3.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return { scope, path: file, exists: true, error: "not a JSON object" };
    return { scope, path: file, exists: true, data };
  } catch (e) {
    return { scope, path: file, exists: true, error: e.message };
  }
}
function loadScopes(root) {
  return [
    load("user", path3.join(claudeDir(), "settings.json")),
    load("project", path3.join(root, ".claude", "settings.json")),
    load("local", localSettingsPath(root)),
    load("managed", managedSettingsPath())
  ];
}
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function isBareToolRule(rule) {
  return typeof rule === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(rule) && !rule.startsWith("mcp__");
}
function stripTrimKeys(data) {
  const out = JSON.parse(JSON.stringify(data ?? {}));
  if (isObj(out.permissions) && Array.isArray(out.permissions.deny)) {
    out.permissions.deny = out.permissions.deny.filter((r) => !isBareToolRule(r));
    if (!out.permissions.deny.length) delete out.permissions.deny;
    if (!Object.keys(out.permissions).length) delete out.permissions;
  }
  if (isObj(out.enabledPlugins)) {
    for (const [k, v] of Object.entries(out.enabledPlugins)) if (v === false) delete out.enabledPlugins[k];
    if (!Object.keys(out.enabledPlugins).length) delete out.enabledPlugins;
  }
  delete out.skillOverrides;
  delete out.disabledMcpjsonServers;
  return out;
}
function effectivePlugins(scopes, opts = {}) {
  const out = {};
  for (const s of scopes) {
    if (s.scope === "managed" || opts.skipLocal && s.scope === "local") continue;
    const ep = s.data?.enabledPlugins;
    if (isObj(ep)) {
      for (const [k, v] of Object.entries(ep)) if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}
function installedPlugins(root) {
  const j = readJson(
    path3.join(claudeDir(), "plugins", "installed_plugins.json")
  );
  const out = [];
  const norm = (p) => path3.resolve(p).toLowerCase();
  for (const [id, installs] of Object.entries(j?.plugins ?? {})) {
    if (installs.some((i) => i.scope === "user" || i.projectPath && norm(i.projectPath) === norm(root))) out.push(id);
  }
  return out;
}

// src/measure.ts
var SEED_TOOLS = [
  "Agent",
  "Artifact",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "ListAgents",
  "PowerShell",
  "Read",
  "ReportFindings",
  "ScheduleWakeup",
  "Skill",
  "ToolSearch",
  "Write"
];
var NEVER_TOGGLE = /* @__PURE__ */ new Set(["Skill", "ToolSearch", "EndConversation", "DeferredToolPlaceholder"]);
function measurementPath(root) {
  return path4.join(projectStateDir(root), "measurement.json");
}
function loadMeasurement(root) {
  return readJson(measurementPath(root));
}
function fingerprint(root, scopes, ccVersion) {
  const h = createHash2("sha256").update(ccVersion);
  const files = [
    ...scopes.map((s) => s.path),
    path4.join(root, ".mcp.json"),
    path4.join(root, "CLAUDE.md"),
    path4.join(root, ".claude", "CLAUDE.md")
  ];
  for (const f of files) {
    try {
      h.update(f).update(fs4.readFileSync(f));
    } catch {
      h.update(`${f}:absent`);
    }
  }
  return h.digest("hex").slice(0, 16);
}
function referenceSpec(scopes) {
  const local = scopes.find((s) => s.scope === "local");
  return { settingSources: "user,project", settings: stripTrimKeys(local?.data) };
}
function withExtra(spec, extra) {
  const s = JSON.parse(JSON.stringify(spec.settings ?? {}));
  for (const [k, v] of Object.entries(extra)) {
    if (k === "permissions") {
      const cur = s.permissions ?? {};
      const deny = [...cur.deny ?? [], ...v.deny ?? []];
      s.permissions = { ...cur, deny };
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      s[k] = { ...s[k] ?? {}, ...v };
    } else {
      s[k] = v;
    }
  }
  return { ...spec, settings: s };
}
function summarize(r, refSkills, quirk) {
  const total = r.totalTokens ?? 0;
  const skills = r.categories["Skills"] ?? 0;
  const adj = quirk && refSkills !== void 0 ? refSkills - skills : 0;
  return { totalTokens: total, correctedTokens: total - adj, categories: r.categories };
}
async function measure(root, opts = {}) {
  const log = opts.log ?? (() => {
  });
  const bin = findClaude();
  if (!bin) throw new Error("Claude Code binary not found. Set CTX_CLAUDE_BIN to the path of claude(.exe). Run `ctx doctor`.");
  const scopes = loadScopes(root);
  const fp = fingerprint(root, scopes, bin.version);
  const cached2 = loadMeasurement(root);
  if (cached2 && !opts.full && !opts.only && cached2.fingerprint === fp) {
    log(`Using cached measurement from ${cached2.measuredAt} (settings unchanged).`);
    return cached2;
  }
  const ref = referenceSpec(scopes);
  log(`Claude Code ${bin.version} at ${bin.path}`);
  log("Measuring reference (untrimmed) and current context...");
  const [refRun, curRun, cap] = await Promise.all([
    runContext(bin.path, root, ref),
    runContext(bin.path, root, {}),
    captureRequest(bin.path, root, ref).catch(() => null)
  ]);
  if (!refRun.ok || !refRun.report) throw new Error(`/context failed for the reference run: ${refRun.error}`);
  if (!curRun.ok || !curRun.report) throw new Error(`/context failed for the current config: ${curRun.error}`);
  const refR = refRun.report;
  const refSkills = refR.categories["Skills"];
  const toolDescriptions = /* @__PURE__ */ new Map();
  let upfront;
  let discovery = "seed";
  if (cap && cap.tools.length) {
    discovery = "capture";
    upfront = cap.tools.filter((t) => !t.deferred).map((t) => t.name);
    for (const t of cap.tools) toolDescriptions.set(t.name, t.description);
  } else {
    upfront = [.../* @__PURE__ */ new Set([...SEED_TOOLS, ...Object.keys(cached2?.items ?? {}).filter((k) => k.startsWith("tool:")).map((k) => k.slice(5))])];
  }
  const eff = effectivePlugins(scopes, { skipLocal: true });
  const plugins = [.../* @__PURE__ */ new Set([...installedPlugins(root), ...Object.keys(eff)])].filter((p) => eff[p] !== false);
  const nonPluginSkills = refR.skills.filter((s) => !pluginOfSource(s.source));
  let jobs = [
    ...upfront.filter((t) => !NEVER_TOGGLE.has(t)).map((t) => ({ id: `tool:${t}`, spec: withExtra(ref, { permissions: { deny: [t] } }) })),
    ...plugins.map((p) => ({ id: `plugin:${p}`, spec: withExtra(ref, { enabledPlugins: { [p]: false } }) }))
  ];
  if (nonPluginSkills.length) {
    jobs.push({
      id: "group:skills-name-only",
      spec: withExtra(ref, { skillOverrides: Object.fromEntries(nonPluginSkills.map((s) => [s.name, "name-only"])) })
    });
  }
  if (opts.only) jobs = jobs.filter((j) => j.id === opts.only || j.id === "group:skills-name-only");
  log(`Running ${jobs.length} toggle measurements (3 at a time, ~4 s each)...`);
  let done = 0;
  const results = await pool(jobs, 3, async (j) => {
    const r = await runContext(bin.path, root, j.spec);
    done++;
    log(`  [${done}/${jobs.length}] ${j.id}: ${r.ok ? `${r.report?.totalTokens}` : `failed (${r.error})`}`);
    return { job: j, r };
  });
  let quirk = cached2?.skillsQuirk ?? false;
  const probe = results.find((x) => x.job.id === "group:skills-name-only" && x.r.ok) ?? results.find((x) => x.job.id.startsWith("plugin:") && x.r.ok);
  if (probe?.r.report && refSkills !== void 0) {
    const dSkills = refSkills - (probe.r.report.categories["Skills"] ?? refSkills);
    const dTotal = (refR.totalTokens ?? 0) - (probe.r.report.totalTokens ?? 0);
    if (dSkills >= 200) quirk = dTotal < dSkills / 2;
  }
  const reference = summarize(refR, refSkills, quirk);
  const items = opts.only && cached2 ? { ...cached2.items } : {};
  for (const { job, r } of results) {
    if (job.id.startsWith("group:")) continue;
    const kind = job.id.startsWith("tool:") ? "tool" : "plugin";
    const name = job.id.slice(job.id.indexOf(":") + 1);
    if (!r.ok || !r.report) {
      items[job.id] = { kind, category: kind === "tool" ? "System tools" : "Skills", deltaTokens: 0, method: "toggle", unmeasured: r.error };
      continue;
    }
    const run = summarize(r.report, refSkills, quirk);
    items[job.id] = {
      kind,
      category: kind === "tool" ? "System tools" : "Skills",
      deltaTokens: Math.max(0, reference.correctedTokens - run.correctedTokens),
      method: "toggle",
      ...kind === "tool" && toolDescriptions.get(name) ? { description: toolDescriptions.get(name) } : {}
    };
  }
  const group = results.find((x) => x.job.id === "group:skills-name-only" && x.r.ok)?.r.report;
  let nameOnlyCost = 15;
  if (group && nonPluginSkills.length) {
    const pluginSkillTokens = refR.skills.filter((s) => pluginOfSource(s.source)).reduce((a, s) => a + s.tokens, 0);
    const est = ((group.categories["Skills"] ?? 0) - pluginSkillTokens) / nonPluginSkills.length;
    if (est > 0 && est < 60) nameOnlyCost = Math.round(est);
  }
  for (const s of refR.skills) {
    const plugin = pluginOfSource(s.source);
    if (plugin) continue;
    items[`skill:${s.name}`] = {
      kind: "skill",
      category: "Skills",
      method: "listed",
      source: s.source,
      deltaTokens: s.tokens,
      softDeltaTokens: Math.max(0, s.tokens - nameOnlyCost)
    };
  }
  const mcpServers = {};
  for (const t of refR.mcpTools) {
    const m2 = mcpServers[t.server] ??= { tools: 0, deferredTokens: 0 };
    m2.tools++;
    m2.deferredTokens += t.tokens;
  }
  for (const [server, m2] of Object.entries(mcpServers)) {
    items[`mcp:${server}`] = { kind: "mcp", category: "MCP tools", method: "listed", deltaTokens: 0, deferredTokens: m2.deferredTokens };
  }
  for (const f of refR.memoryFiles) {
    items[`memory:${f.path}`] = { kind: "memory", category: "Memory files", method: "listed", deltaTokens: f.tokens, source: f.type };
  }
  const m = {
    ccVersion: bin.version,
    binary: bin.path,
    model: refR.model,
    project: projectKey(root),
    measuredAt: (/* @__PURE__ */ new Date()).toISOString(),
    fingerprint: fp,
    reference,
    current: summarize(curRun.report, refSkills, quirk),
    skillsQuirk: quirk,
    toolDiscovery: discovery,
    upfrontTools: upfront,
    items,
    skills: refR.skills.map((s) => ({ name: s.name, source: s.source, tokens: s.tokens, plugin: pluginOfSource(s.source) })),
    mcpServers,
    memoryFiles: refR.memoryFiles.map((f) => ({ path: f.path, type: f.type, tokens: f.tokens })),
    unparsed: refR.unparsed.map((u) => u.heading)
  };
  writeJson(measurementPath(root), m);
  return m;
}

// src/usage.ts
import fs5 from "node:fs";
import path5 from "node:path";
import readline from "node:readline";
function normalizeSkillName(name) {
  return name.replace(/^anthropic-skills:/, "");
}
function itemsForToolUse(name, input) {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts.length >= 3 && parts[1] ? [`mcp:${parts[1]}`] : [];
  }
  const out = [`tool:${name}`];
  if (name === "Skill" && typeof input?.skill === "string") out.push(`skill:${normalizeSkillName(input.skill)}`);
  if (name === "Agent" && typeof input?.subagent_type === "string") out.push(`agent:${input.subagent_type}`);
  return out;
}
var COMMAND_RE = /<command-name>\/?([^<\s]+)<\/command-name>/g;
async function scanFile(file, into) {
  const stream = fs5.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const bump = (id, ts) => {
    const c = into.calls.get(id) ?? { n: 0 };
    c.n++;
    if (ts && (!c.last || ts > c.last)) c.last = ts;
    into.calls.set(id, c);
  };
  for await (const line of rl) {
    if (!line.includes('"assistant"') && !line.includes("command-name")) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof j.timestamp === "string" ? j.timestamp : void 0;
    const content = j.message?.content;
    if (j.type === "assistant") {
      into.assistantTurns++;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === "tool_use" && typeof c.name === "string") for (const id of itemsForToolUse(c.name, c.input)) bump(id, ts);
      }
    } else if (j.type === "user") {
      const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text ?? "") : [];
      for (const t of texts) for (const m of t.matchAll(COMMAND_RE)) bump(`skill:${normalizeSkillName(m[1])}`, ts);
    }
  }
}
async function buildLedger(root, opts = {}) {
  const window = opts.sessions ?? 10;
  const files = [];
  for (const dir of transcriptDirs(root)) {
    for (const f of fs5.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path5.join(dir, f);
      try {
        files.push({ file: full, id: f.slice(0, -6), mtime: fs5.statSync(full).mtimeMs, dir });
      } catch {
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const prev = loadLedger(root);
  const ledger = {
    project: projectKey(root),
    builtAt: (/* @__PURE__ */ new Date()).toISOString(),
    sessionsScanned: 0,
    window: { sessions: window },
    sessions: [],
    items: {},
    reenables: prev?.reenables ?? {},
    global: readGlobalCounters()
  };
  for (const f of files) {
    if (ledger.sessions.length >= window) break;
    ledger.sessionsScanned++;
    const scan = { calls: /* @__PURE__ */ new Map(), assistantTurns: 0 };
    await scanFile(f.file, scan);
    if (scan.assistantTurns === 0) continue;
    const subDir = path5.join(f.dir, f.id, "subagents");
    try {
      for (const s of fs5.readdirSync(subDir)) if (s.endsWith(".jsonl")) await scanFile(path5.join(subDir, s), scan);
    } catch {
    }
    let calls = 0;
    for (const [id, c] of scan.calls) {
      const it = ledger.items[id] ??= { sessionsUsed: 0, calls: 0 };
      it.sessionsUsed++;
      it.calls += c.n;
      if (id.startsWith("tool:") || id.startsWith("mcp:")) calls += c.n;
      if (c.last && (!it.lastUsedAt || c.last > it.lastUsedAt)) it.lastUsedAt = c.last;
    }
    ledger.sessions.push({ id: f.id, file: f.file, mtime: new Date(f.mtime).toISOString(), calls });
  }
  writeJson(ledgerPath(root), ledger);
  return ledger;
}
function readGlobalCounters() {
  const j = readJson(claudeJsonPath());
  return { skillUsage: j?.skillUsage ?? {}, pluginUsage: j?.pluginUsage ?? {} };
}
function ledgerPath(root) {
  return path5.join(projectStateDir(root), "ledger.json");
}
function loadLedger(root) {
  return readJson(ledgerPath(root));
}

// src/doctor.ts
function age(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 6e4);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}
function renderDoctor(root) {
  const out = [];
  out.push(`ctx doctor: ${projectKey(root)}`);
  out.push(`  node ${process.version} on ${process.platform}`);
  const bin = findClaude();
  if (bin) out.push(`  claude binary: ${bin.path}  (v${bin.version}, via ${bin.source})`);
  else {
    out.push("  claude binary: NOT FOUND. Set CTX_CLAUDE_BIN to the full path of claude(.exe). Checked:");
    for (const c of candidates()) out.push(`    - ${c.path} (${c.source})${fs6.existsSync(c.path) ? " [exists, --version failed]" : ""}`);
  }
  out.push("  settings files:");
  const scopes = loadScopes(root);
  for (const s of scopes) {
    const state = !s.exists ? "absent" : s.error ? `INVALID: ${s.error}` : "ok";
    out.push(`    ${s.scope.padEnd(8)} ${s.path}  [${state}]`);
  }
  const dirs = transcriptDirs(root);
  out.push(`  transcript dirs: ${dirs.length ? "" : "none found"}`);
  for (const d of dirs) {
    const n = fs6.readdirSync(d).filter((f) => f.endsWith(".jsonl")).length;
    out.push(`    ${d}  (${n} sessions)`);
  }
  const cj = readJson(claudeJsonPath());
  const pe = cj?.projects?.[projectKey(root)];
  out.push(`  ~/.claude.json project entry: ${pe ? "found" : "not found"}${pe?.disabledMcpServers?.length ? ` (disabled MCP: ${pe.disabledMcpServers.join(", ")})` : ""}`);
  out.push(`  state dir: ${projectStateDir(root)}`);
  const m = loadMeasurement(root);
  if (m) {
    const fresh = bin ? fingerprint(root, scopes, bin.version) === m.fingerprint ? "current" : "STALE (settings or version changed)" : "unknown";
    out.push(`  measurement: ${age(m.measuredAt)}, Claude Code ${m.ccVersion}, ${fresh}; tool list via ${m.toolDiscovery}; skills quirk ${m.skillsQuirk ? "on" : "off"}`);
    if (m.unparsed.length) out.push(`  /context sections not parsed: ${m.unparsed.join(", ")}`);
  } else {
    out.push(`  measurement: none (${measurementPath(root)})`);
  }
  const l = loadLedger(root);
  out.push(l ? `  usage ledger: ${age(l.builtAt)}, ${l.sessions.length} sessions` : `  usage ledger: none (${ledgerPath(root)})`);
  out.push("  profile: not applied (ctx apply arrives in M2)");
  out.push(`  ctx home: ${ctxHome()}`);
  return out.join("\n");
}

// src/protect.ts
import fs7 from "node:fs";
import path6 from "node:path";
var ALWAYS = ["Read", "Edit", "Write", "Glob", "Grep", "Skill", "ToolSearch", "AskUserQuestion", "EndConversation"];
function claudeMdMentions(word) {
  for (const f of [path6.join(claudeDir(), "CLAUDE.md")]) {
    try {
      const text = fs7.readFileSync(f, "utf8");
      if (text.includes(word)) return true;
      for (const m of text.matchAll(/^@(\S+)/gm)) {
        try {
          if (fs7.readFileSync(path6.resolve(path6.dirname(f), m[1]), "utf8").includes(word)) return true;
        } catch {
        }
      }
    } catch {
    }
  }
  return false;
}
function protectedIds(opts = {}) {
  const ids = new Set(ALWAYS.map((t) => `tool:${t}`));
  ids.add("tool:Bash");
  const platform = opts.platform ?? process.platform;
  if (platform === "win32" && ((opts.ledger?.items["tool:PowerShell"]?.sessionsUsed ?? 0) > 0 || claudeMdMentions("PowerShell"))) {
    ids.add("tool:PowerShell");
  }
  if (!opts.unprotectAgent) ids.add("tool:Agent");
  ids.add("skill:ctx:enable");
  for (const k of opts.keep ?? []) ids.add(k);
  return ids;
}

// src/report.ts
var WIDTH = 100;
function wrapJoin(prefix, parts, indent = prefix.length) {
  const lines = [];
  let cur = prefix;
  for (let i = 0; i < parts.length; i++) {
    const piece = (i === 0 ? "" : " \xB7 ") + parts[i];
    if (cur.length + piece.length > WIDTH && cur.trim().length > prefix.trim().length) {
      lines.push(cur);
      cur = " ".repeat(indent) + parts[i];
    } else {
      cur += piece;
    }
  }
  lines.push(cur);
  return lines.join("\n");
}
function activeTrims(scopes) {
  const out = { tools: [], plugins: [], skills: [] };
  const pluginState = /* @__PURE__ */ new Map();
  const skillState = /* @__PURE__ */ new Map();
  for (const s of scopes) {
    const d = s.data;
    if (!d) continue;
    const perms = d.permissions;
    for (const r of perms?.deny ?? []) if (isBareToolRule(r) && !out.tools.some((t) => t.name === r)) out.tools.push({ name: r, scope: s.scope });
    const ep = d.enabledPlugins;
    if (ep && typeof ep === "object") {
      for (const [k, v] of Object.entries(ep)) if (typeof v === "boolean") pluginState.set(k, { v, scope: s.scope });
    }
    const so = d.skillOverrides;
    if (so && typeof so === "object") {
      for (const [k, v] of Object.entries(so)) if (typeof v === "string") skillState.set(k, { v, scope: s.scope });
    }
  }
  for (const [id, st] of pluginState) if (!st.v) out.plugins.push({ id, scope: st.scope });
  for (const [name, st] of skillState) if (st.v !== "on") out.skills.push({ name, level: st.v, scope: st.scope });
  return out;
}
function correctedCategories(run, ref, quirk) {
  const c = { ...run.categories };
  if (quirk && c["System tools"] !== void 0) {
    c["System tools"] -= (ref.categories["Skills"] ?? 0) - (c["Skills"] ?? 0);
  }
  return c;
}
function pct(from, to) {
  if (!from) return "";
  return `${Math.round((to - from) / from * 100)}%`;
}
function renderReport(root, m, ledger) {
  const out = [];
  const scopes = loadScopes(root);
  const trims = activeTrims(scopes);
  const date = m.measuredAt.slice(0, 10);
  out.push(`ctx report: ${m.project}   (Claude Code ${m.ccVersion}, measured ${date})`);
  out.push("");
  const cur = m.current.correctedTokens;
  const ref = m.reference.correctedTokens;
  const headline = cur < ref ? `Upfront per new session: ${fmtK(cur)} (untrimmed ${fmtK(ref)}, ${pct(ref, cur)})` : `Upfront per new session: ${fmtK(cur)} (nothing trimmed)`;
  out.push(headline);
  if (m.skillsQuirk && m.current.totalTokens !== m.current.correctedTokens) {
    out.push(`  (/context shows ${fmtK(m.current.totalTokens)}: its total doesn't subtract skill and plugin trims.)`);
  }
  const cats = correctedCategories(m.current, m.reference, m.skillsQuirk);
  const tools = Object.entries(m.items).filter(([id, it]) => id.startsWith("tool:") && it.deltaTokens > 0 && !trims.tools.some((t) => `tool:${t.name}` === id)).sort((a, b) => b[1].deltaTokens - a[1].deltaTokens).map(([id, it]) => `${id.slice(5)} ${fmtK1(it.deltaTokens)}`);
  const row = (label, v, note = "") => `  ${label.padEnd(18)} ${fmtK1(v ?? 0).padStart(6)}${note ? "   " + note : ""}`;
  out.push(row("System prompt", cats["System prompt"]));
  out.push(wrapJoin(row("Built-in tools", cats["System tools"]) + "   deny saves: ", tools.slice(0, 6), 30) + (tools.length > 6 ? " \xB7 ..." : ""));
  const skillLevels = trims.skills.reduce((a, s) => (a[s.level] = (a[s.level] ?? 0) + 1, a), {});
  out.push(row("Skills", cats["Skills"], Object.entries(skillLevels).map(([k, n]) => `${n} ${k}`).join(", ")));
  const mcpUp = (cats["MCP tools"] ?? 0) + (cats["MCP server instructions"] ?? 0);
  const servers = Object.keys(m.mcpServers).length;
  out.push(row("MCP", mcpUp, servers ? `${servers} server${servers === 1 ? "" : "s"}, tools deferred` : ""));
  out.push(row("Memory files", cats["Memory files"], m.memoryFiles.length ? `${m.memoryFiles.length} file${m.memoryFiles.length === 1 ? "" : "s"}` : ""));
  out.push("");
  const usedNote = (id) => {
    const n = ledger?.items[id]?.sessionsUsed ?? 0;
    return n ? `, USED in ${n} recent session${n === 1 ? "" : "s"}` : "";
  };
  const off = [];
  for (const t of trims.tools) off.push(`tool ${t.name} (${fmtK1(m.items[`tool:${t.name}`]?.deltaTokens ?? 0)}${t.scope !== "local" ? `, ${t.scope}` : ""}${usedNote(`tool:${t.name}`)})`);
  for (const p of trims.plugins) off.push(`plugin ${p.id.split("@")[0]} (${fmtK1(m.items[`plugin:${p.id}`]?.deltaTokens ?? 0)}${p.scope !== "local" ? `, ${p.scope}` : ""})`);
  const offSkills = trims.skills.filter((s) => s.level === "off");
  for (const s of offSkills) off.push(`skill ${s.name} (off)`);
  out.push(off.length ? wrapJoin("Switched off:  ", off) : "Switched off:  nothing");
  if (ledger) {
    const used = Object.entries(ledger.items).filter(([id]) => id.startsWith("tool:") || id.startsWith("skill:") || id.startsWith("mcp:")).sort((a, b) => b[1].sessionsUsed - a[1].sessionsUsed || b[1].calls - a[1].calls).map(([id, u]) => `${id.replace(/^tool:/, "").replace(/^skill:/, "skill ").replace(/^mcp:/, "mcp ")} ${u.sessionsUsed}`);
    out.push(wrapJoin(`Usage, last ${ledger.sessions.length} sessions (sessions used): `, used.slice(0, 14), 2) + (used.length > 14 ? " \xB7 ..." : ""));
  } else {
    out.push("Usage: not collected yet (ctx usage).");
  }
  const prot = protectedIds({ ledger });
  const trimmedIds = /* @__PURE__ */ new Set([
    ...trims.tools.map((t) => `tool:${t.name}`),
    ...trims.plugins.map((p) => `plugin:${p.id}`),
    ...trims.skills.map((s) => `skill:${s.name}`)
  ]);
  const usedPlugins = new Set(Object.keys(ledger?.items ?? {}).filter((id) => id.startsWith("skill:") && id.includes(":", 6)).map((id) => id.slice(6).split(":")[0]));
  const sugg = Object.entries(m.items).filter(([id, it]) => (it.kind === "tool" || it.kind === "plugin" || it.kind === "skill") && !prot.has(id) && !trimmedIds.has(id)).filter(([id]) => !ledger?.items[id]?.sessionsUsed).filter(([id]) => !(id.startsWith("plugin:") && usedPlugins.has(id.slice(7).split("@")[0]))).map(([id, it]) => ({ id, save: it.kind === "skill" ? it.softDeltaTokens ?? 0 : it.deltaTokens })).filter((s) => s.save >= 200).sort((a, b) => b.save - a.save).map((s) => `${s.id} ${fmtK1(s.save)}`);
  out.push(sugg.length ? wrapJoin("Unused here, >=200 tokens: ", sugg) : "Suggestions: none above 200 tokens.");
  out.push(`Measured ${m.measuredAt.slice(0, 16).replace("T", " ")} UTC \xB7 re-measure: ctx measure --full`);
  return out.join("\n");
}

// src/cli.ts
var HELP = `ctx: measure and trim what each Claude Code session loads.

Usage: ctx <command> [flags]
  measure [--full] [--only <id>] [--json]   measure upfront context (free; no model call)
  usage [--sessions N] [--json]             build the usage ledger from this project's transcripts
  report [--json]                           breakdown, what's off, usage, suggestions
  doctor                                    diagnose binary, settings, transcripts, cache
Global: --project <dir> (default: CLAUDE_PROJECT_DIR or cwd)
Coming in M2+: plan, apply, on, off, undo, hook, global`;
async function main(argv) {
  const a = parseArgs(argv);
  const root = resolveProjectRoot(typeof a.flags.project === "string" ? a.flags.project : void 0);
  const log = (s) => process.stderr.write(s + "\n");
  switch (a.cmd) {
    case "measure": {
      const m = await measure(root, {
        full: !!a.flags.full,
        only: typeof a.flags.only === "string" ? a.flags.only : void 0,
        log: a.flags.json ? void 0 : log
      });
      if (a.flags.json) {
        console.log(JSON.stringify(m, null, 2));
        return 0;
      }
      const tools = Object.entries(m.items).filter(([id]) => id.startsWith("tool:")).sort((x, y) => y[1].deltaTokens - x[1].deltaTokens);
      const plugins = Object.entries(m.items).filter(([id]) => id.startsWith("plugin:"));
      console.log(`Untrimmed: ${fmtK(m.reference.correctedTokens)} \xB7 current: ${fmtK(m.current.correctedTokens)}` + (m.skillsQuirk ? ` (/context shows ${fmtK(m.current.totalTokens)})` : ""));
      console.log(`Tools (${m.toolDiscovery}): ` + tools.map(([id, it]) => `${id.slice(5)} ${it.unmeasured ? "?" : fmtK(it.deltaTokens)}`).join(" \xB7 "));
      if (plugins.length) console.log("Plugins: " + plugins.map(([id, it]) => `${id.slice(7)} ${it.unmeasured ? "?" : fmtK(it.deltaTokens)}`).join(" \xB7 "));
      console.log(`Skills: ${m.skills.length} listed, ${fmtK(m.reference.categories["Skills"] ?? 0)} untrimmed`);
      return 0;
    }
    case "usage": {
      const n = typeof a.flags.sessions === "string" ? parseInt(a.flags.sessions, 10) : void 0;
      const l = await buildLedger(root, { sessions: n && n > 0 ? n : void 0 });
      if (a.flags.json) {
        console.log(JSON.stringify(l, null, 2));
        return 0;
      }
      console.log(`Scanned ${l.sessionsScanned} transcripts; ${l.sessions.length} sessions with assistant turns in the window.`);
      const top = Object.entries(l.items).sort((x, y) => y[1].sessionsUsed - x[1].sessionsUsed || y[1].calls - x[1].calls);
      for (const [id, u] of top.slice(0, 30)) console.log(`  ${id.padEnd(44)} ${String(u.sessionsUsed).padStart(3)} sessions ${String(u.calls).padStart(5)} calls  last ${u.lastUsedAt?.slice(0, 16) ?? "-"}`);
      return 0;
    }
    case "report": {
      let m = loadMeasurement(root);
      if (!m) {
        log("No measurement yet; measuring now...");
        m = await measure(root, { log });
      }
      const l = loadLedger(root) ?? await buildLedger(root);
      if (a.flags.json) {
        console.log(JSON.stringify({ measurement: m, ledger: l }, null, 2));
        return 0;
      }
      console.log(renderReport(root, m, l));
      return 0;
    }
    case "doctor":
      console.log(renderDoctor(root));
      return 0;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown or not yet implemented command: ${a.cmd}

${HELP}`);
      return 2;
  }
}
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (e) => {
  console.error(`ctx: ${e.message ?? String(e)}`);
  process.exitCode = 1;
});
