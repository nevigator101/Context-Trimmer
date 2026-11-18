#!/usr/bin/env node

// src/args.ts
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const valued = /* @__PURE__ */ new Set(["only", "sessions", "plan", "project", "set", "groups", "reason", "level", "min-tokens"]);
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
import fs7 from "node:fs";

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
        description: firstSentence(t.description ?? ""),
        inputSchema: t.input_schema
      })),
      systemChars: JSON.stringify(j.system ?? "").length,
      messagesChars: JSON.stringify(j.messages ?? []).length,
      skillDescriptions: parseSkillListing(collectText(j.messages))
    };
  } catch {
    return null;
  }
}
function collectText(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectText(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) if (k === "text" || k === "content") collectText(x, out);
  }
  return out.join("\n");
}
function parseSkillListing(text) {
  const out = {};
  const start = text.indexOf("following skills are available");
  if (start < 0) return out;
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (line.includes("</system-reminder>")) break;
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2);
    const i = body.indexOf(": ");
    const name = (i >= 0 ? body.slice(0, i) : body).trim();
    if (!name || /\s/.test(name)) continue;
    out[name.replace(/^anthropic-skills:/, "")] = i >= 0 ? firstSentence(body.slice(i + 2)) : "";
  }
  return out;
}
function firstSentence(text, max = 80) {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = flat.match(/^(.+?[.!?])(?=\s+["'(]?[A-Z]|$)/);
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
function pluginDescriptions() {
  const j = readJson(
    path3.join(claudeDir(), "plugins", "installed_plugins.json")
  );
  const out = {};
  for (const [id, installs] of Object.entries(j?.plugins ?? {})) {
    for (const i of installs) {
      if (!i.installPath) continue;
      const pj = readJson(path3.join(i.installPath, ".claude-plugin", "plugin.json"));
      if (pj?.description) {
        out[id] = pj.description;
        break;
      }
    }
  }
  return out;
}
function findRule(scopes, kind, key) {
  return scopes.filter((s) => {
    const d = s.data;
    if (!d) return false;
    if (kind === "deny") return isObj(d.permissions) && Array.isArray(d.permissions.deny) && d.permissions.deny.includes(key);
    if (kind === "plugin") return isObj(d.enabledPlugins) && d.enabledPlugins[key] === false;
    return isObj(d.skillOverrides) && key in d.skillOverrides;
  });
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
  const local = scopes.find((s) => s.scope === "local");
  h.update(`local:${local?.exists ? JSON.stringify(stripTrimKeys(local.data)) : "absent"}`);
  const files = [
    ...scopes.filter((s) => s.scope !== "local").map((s) => s.path),
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
  const toolSchemas = {};
  let upfront;
  let discovery = "seed";
  if (cap && cap.tools.length) {
    discovery = "capture";
    upfront = cap.tools.filter((t) => !t.deferred).map((t) => t.name);
    for (const t of cap.tools) {
      toolDescriptions.set(t.name, t.description);
      if (!t.deferred && t.inputSchema) toolSchemas[t.name] = t.inputSchema;
    }
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
  const pluginDesc = pluginDescriptions();
  for (const [id, d] of Object.entries(pluginDesc)) toolDescriptions.set(id, firstSentence(d));
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
      ...toolDescriptions.get(name) ? { description: toolDescriptions.get(name) } : {}
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
    toolSchemas: Object.keys(toolSchemas).length ? toolSchemas : cached2?.toolSchemas ?? {},
    skillDescriptions: cap && Object.keys(cap.skillDescriptions).length ? cap.skillDescriptions : cached2?.skillDescriptions ?? {},
    items,
    skills: refR.skills.map((s) => ({ name: s.name, source: s.source, tokens: s.tokens, plugin: pluginOfSource(s.source) })),
    mcpServers,
    memoryFiles: refR.memoryFiles.map((f) => ({ path: f.path, type: f.type, tokens: f.tokens })),
    unparsed: refR.unparsed.map((u) => u.heading)
  };
  writeJson(measurementPath(root), m);
  return m;
}
async function verifyRun(root, settings, reference, quirk) {
  const bin = findClaude();
  if (!bin) throw new Error("Claude Code binary not found.");
  const r = await runContext(bin.path, root, { settings });
  if (!r.ok || !r.report) throw new Error(`verification /context failed: ${r.error}`);
  return summarize(r.report, reference.categories["Skills"], quirk);
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
function globalSkillCount(l, skill) {
  const g = l.global.skillUsage;
  return (g[skill]?.usageCount ?? 0) + (g[`anthropic-skills:${skill}`]?.usageCount ?? 0);
}

// src/writer.ts
import { createHash as createHash3 } from "node:crypto";
import fs6 from "node:fs";
import path6 from "node:path";
var emptyEntries = () => ({ deny: [], plugins: {}, skills: {}, mcpjson: [], allow: [] });
function emptyApplied(file) {
  return { version: 1, file, owned: emptyEntries(), preexisting: emptyEntries(), history: [] };
}
var KEEP_BACKUPS = 20;
function appliedPath(root) {
  return path6.join(projectStateDir(root), "applied.json");
}
function backupDir(root) {
  return path6.join(projectStateDir(root), "backups");
}
function loadApplied(root) {
  const a = readJson(appliedPath(root)) ?? emptyApplied(localSettingsPath(root));
  a.owned = { ...emptyEntries(), ...a.owned };
  a.preexisting = { ...emptyEntries(), ...a.preexisting };
  return a;
}
var realOps = { renameSync: fs6.renameSync };
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function sha(b) {
  return createHash3("sha256").update(b).digest("hex");
}
function detectStyle(raw) {
  if (!raw) return { indent: 2, eol: "\n", finalNewline: true };
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const m = raw.match(/\n([ \t]+)\S/);
  const indent = m ? m[1].startsWith("	") ? "	" : m[1].length : 2;
  return { indent, eol, finalNewline: /\r?\n$/.test(raw) };
}
function serialize(obj, style) {
  let s = JSON.stringify(obj, null, style.indent);
  if (style.eol === "\r\n") s = s.replace(/\n/g, "\r\n");
  return style.finalNewline ? s + style.eol : s;
}
function atomicWrite(file, data, ops = realOps) {
  fs6.mkdirSync(path6.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs6.openSync(tmp, "w");
  try {
    fs6.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs6.fsyncSync(fd);
  } finally {
    fs6.closeSync(fd);
  }
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      ops.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (i < 5) sleepSync(100);
    }
  }
  try {
    fs6.unlinkSync(tmp);
  } catch {
  }
  throw new Error(`could not replace ${file}: ${lastErr?.message ?? lastErr}`);
}
function newBackupId(dir) {
  let id = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  let n = 0;
  while (fs6.existsSync(path6.join(dir, `${id}.state.json`))) id = `${id.replace(/_\d+$/, "")}_${++n}`;
  return id;
}
function backup(root) {
  const dir = backupDir(root);
  fs6.mkdirSync(dir, { recursive: true });
  const id = newBackupId(dir);
  const file = localSettingsPath(root);
  const exists = fs6.existsSync(file);
  if (exists) fs6.copyFileSync(file, path6.join(dir, `${id}.settings.local.json`));
  const applied = readJson(appliedPath(root));
  fs6.writeFileSync(path6.join(dir, `${id}.state.json`), JSON.stringify({ settingsExisted: exists, applied: applied ?? null }));
  return id;
}
function listBackups(root) {
  try {
    return fs6.readdirSync(backupDir(root)).filter((f) => f.endsWith(".state.json")).map((f) => f.slice(0, -".state.json".length)).sort();
  } catch {
    return [];
  }
}
function pruneBackups(root, keep) {
  const all = listBackups(root).filter((b) => b !== keep);
  for (const id of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) removeBackup(root, id);
}
function removeBackup(root, id) {
  for (const suffix of [".settings.local.json", ".state.json"]) {
    try {
      fs6.unlinkSync(path6.join(backupDir(root), id + suffix));
    } catch {
    }
  }
}
function restoreBackup(root, id, ops = realOps) {
  const dir = backupDir(root);
  const st = JSON.parse(fs6.readFileSync(path6.join(dir, `${id}.state.json`), "utf8"));
  const file = localSettingsPath(root);
  if (st.settingsExisted) atomicWrite(file, fs6.readFileSync(path6.join(dir, `${id}.settings.local.json`)), ops);
  else if (fs6.existsSync(file)) fs6.unlinkSync(file);
  if (st.applied) writeJson(appliedPath(root), st.applied);
  else try {
    fs6.unlinkSync(appliedPath(root));
  } catch {
  }
}
function writeSettings(root, action, mutate, ops = realOps) {
  const file = localSettingsPath(root);
  const raw = fs6.existsSync(file) ? fs6.readFileSync(file, "utf8") : void 0;
  let settings = {};
  if (raw !== void 0 && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      settings = parsed;
    } catch (e) {
      throw new Error(`${file} is not valid JSON (${e.message}); ctx won't overwrite it. Fix it first.`);
    }
  }
  const applied = loadApplied(root);
  const id = backup(root);
  if (!applied.originalBackup) applied.originalBackup = id;
  const changes = mutate(settings, applied);
  if (!changes.length) {
    removeBackup(root, id);
    if (applied.originalBackup === id) delete applied.originalBackup;
    return { backup: "", changes, file };
  }
  const text = serialize(settings, detectStyle(raw));
  try {
    atomicWrite(file, text, ops);
    JSON.parse(fs6.readFileSync(file, "utf8"));
  } catch (e) {
    try {
      restoreBackup(root, id);
    } catch {
    }
    throw new Error(`write failed, original restored: ${e.message}`);
  }
  applied.lastWrittenHash = sha(text);
  applied.history.push({ at: (/* @__PURE__ */ new Date()).toISOString(), action, backup: id, summary: changes.join("; ").slice(0, 500) });
  writeJson(appliedPath(root), applied);
  pruneBackups(root, applied.originalBackup);
  return { backup: id, changes, file };
}
function editedSinceWrite(root, applied) {
  const file = localSettingsPath(root);
  if (!applied.lastWrittenHash) return false;
  if (!fs6.existsSync(file)) return true;
  return sha(fs6.readFileSync(file, "utf8")) !== applied.lastWrittenHash;
}
function undo(root, all = false, ops = realOps) {
  const applied = loadApplied(root);
  const backups = listBackups(root);
  if (!backups.length) throw new Error("nothing to undo: ctx has no backups for this project");
  const target = all ? applied.originalBackup ?? backups[0] : backups[backups.length - 1];
  let manual;
  if (editedSinceWrite(root, applied)) {
    const dir = backupDir(root);
    manual = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.pre-undo.settings.local.json`;
    const file2 = localSettingsPath(root);
    if (fs6.existsSync(file2)) fs6.copyFileSync(file2, path6.join(dir, manual));
  }
  restoreBackup(root, target, ops);
  const st = JSON.parse(fs6.readFileSync(path6.join(backupDir(root), `${target}.state.json`), "utf8"));
  const original = applied.originalBackup;
  for (const b of backups.filter((b2) => b2 >= target)) if (b !== original) removeBackup(root, b);
  const after = loadApplied(root);
  const file = localSettingsPath(root);
  after.lastWrittenHash = fs6.existsSync(file) ? sha(fs6.readFileSync(file, "utf8")) : void 0;
  after.originalBackup = original;
  if (all) {
    after.owned = emptyEntries();
    after.preexisting = emptyEntries();
    delete after.verified;
  }
  after.history = [...applied.history, { at: (/* @__PURE__ */ new Date()).toISOString(), action: all ? "undo all" : "undo", backup: target, summary: `restored ${target}` }];
  writeJson(appliedPath(root), after);
  return { restored: target, manualEditsSaved: manual, deleted: !st.settingsExisted };
}
var isObj2 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function permList(s, key, create) {
  if (!isObj2(s.permissions)) {
    if (!create) return void 0;
    s.permissions = {};
  }
  const p = s.permissions;
  if (!Array.isArray(p[key])) {
    if (!create) return void 0;
    p[key] = [];
  }
  return p[key];
}
var denyList = (s, create) => permList(s, "deny", create);
function objKey(s, key, create) {
  if (!isObj2(s[key])) {
    if (!create) return void 0;
    s[key] = {};
  }
  return s[key];
}
function cleanupEmpty(s) {
  if (isObj2(s.permissions)) {
    if (Array.isArray(s.permissions.deny) && !s.permissions.deny.length) delete s.permissions.deny;
    if (Array.isArray(s.permissions.allow) && !s.permissions.allow.length) delete s.permissions.allow;
    if (!Object.keys(s.permissions).length) delete s.permissions;
  }
  for (const k of ["enabledPlugins", "skillOverrides"]) if (isObj2(s[k]) && !Object.keys(s[k]).length) delete s[k];
  if (Array.isArray(s.disabledMcpjsonServers) && !s.disabledMcpjsonServers.length) delete s.disabledMcpjsonServers;
}
function describeRef(r) {
  if (r.kind === "allow") return `allow ${r.rule}`;
  if (r.kind === "tool") return `deny ${r.name}`;
  if (r.kind === "plugin") return `plugin ${r.id} off`;
  if (r.kind === "skill") return `skill ${r.name} ${r.level}`;
  return `.mcp.json server ${r.name} off`;
}
function setEntry(s, a, r) {
  if (r.kind === "allow") {
    const allow = permList(s, "allow", true);
    if (allow.includes(r.rule)) {
      if (!a.owned.allow.includes(r.rule) && !a.preexisting.allow.includes(r.rule)) a.preexisting.allow.push(r.rule);
      return void 0;
    }
    allow.push(r.rule);
    a.owned.allow.push(r.rule);
    return describeRef(r);
  }
  if (r.kind === "tool") {
    const deny = denyList(s, true);
    if (deny.includes(r.name)) {
      if (!a.owned.deny.includes(r.name) && !a.preexisting.deny.includes(r.name)) a.preexisting.deny.push(r.name);
      return void 0;
    }
    deny.push(r.name);
    a.owned.deny.push(r.name);
    return describeRef(r);
  }
  if (r.kind === "plugin") {
    const ep = objKey(s, "enabledPlugins", true);
    if (ep[r.id] === false) {
      if (!(r.id in a.owned.plugins)) a.preexisting.plugins[r.id] = false;
      return void 0;
    }
    if (r.id in ep && !(r.id in a.owned.plugins)) return `skipped plugin ${r.id}: set to ${String(ep[r.id])} by you`;
    ep[r.id] = false;
    a.owned.plugins[r.id] = false;
    return describeRef(r);
  }
  if (r.kind === "skill") {
    const so = objKey(s, "skillOverrides", true);
    if (so[r.name] === r.level) {
      if (!(r.name in a.owned.skills)) a.preexisting.skills[r.name] = r.level;
      return void 0;
    }
    if (r.name in so && !(r.name in a.owned.skills)) return `skipped skill ${r.name}: set to "${String(so[r.name])}" by you`;
    so[r.name] = r.level;
    a.owned.skills[r.name] = r.level;
    return describeRef(r);
  }
  if (!Array.isArray(s.disabledMcpjsonServers)) s.disabledMcpjsonServers = [];
  const list = s.disabledMcpjsonServers;
  if (list.includes(r.name)) {
    if (!a.owned.mcpjson.includes(r.name)) a.preexisting.mcpjson.push(r.name);
    return void 0;
  }
  list.push(r.name);
  a.owned.mcpjson.push(r.name);
  return describeRef(r);
}
function clearEntry(s, a, r, force = false) {
  const drop = (arr, v) => {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
  };
  let result = "absent";
  if (r.kind === "allow") {
    const allow = permList(s, "allow", false);
    if (allow?.includes(r.rule)) {
      if (a.owned.allow.includes(r.rule) || force) {
        drop(allow, r.rule);
        drop(a.owned.allow, r.rule);
        drop(a.preexisting.allow, r.rule);
        result = "removed";
      } else result = "not-owned";
    }
  } else if (r.kind === "tool") {
    const deny = denyList(s, false);
    if (deny?.includes(r.name)) {
      if (a.owned.deny.includes(r.name) || force) {
        drop(deny, r.name);
        drop(a.owned.deny, r.name);
        drop(a.preexisting.deny, r.name);
        result = "removed";
      } else result = "not-owned";
    }
  } else if (r.kind === "plugin") {
    const ep = objKey(s, "enabledPlugins", false);
    if (ep && ep[r.id] === false) {
      if (r.id in a.owned.plugins || force) {
        delete ep[r.id];
        delete a.owned.plugins[r.id];
        delete a.preexisting.plugins[r.id];
        result = "removed";
      } else result = "not-owned";
    }
  } else if (r.kind === "skill") {
    const so = objKey(s, "skillOverrides", false);
    if (so && r.name in so && so[r.name] !== "on") {
      if (r.name in a.owned.skills || force) {
        delete so[r.name];
        delete a.owned.skills[r.name];
        delete a.preexisting.skills[r.name];
        result = "removed";
      } else result = "not-owned";
    }
  } else {
    const list = Array.isArray(s.disabledMcpjsonServers) ? s.disabledMcpjsonServers : void 0;
    if (list?.includes(r.name)) {
      if (a.owned.mcpjson.includes(r.name) || force) {
        drop(list, r.name);
        drop(a.owned.mcpjson, r.name);
        result = "removed";
      } else result = "not-owned";
    }
  }
  cleanupEmpty(s);
  return result;
}
function ownedRefs(a) {
  return [
    ...a.owned.deny.map((name) => ({ kind: "tool", name })),
    ...Object.keys(a.owned.plugins).map((id) => ({ kind: "plugin", id })),
    ...Object.entries(a.owned.skills).map(([name, level]) => ({ kind: "skill", name, level })),
    ...a.owned.mcpjson.map((name) => ({ kind: "mcpjson", name })),
    ...a.owned.allow.map((rule) => ({ kind: "allow", rule }))
  ];
}
function refKey(r) {
  if (r.kind === "allow") return `allow:${r.rule}`;
  return r.kind === "plugin" ? `plugin:${r.id}` : r.kind === "mcpjson" ? `mcpjson:${r.name}` : `${r.kind}:${r.name}`;
}
var ENABLE_RULE = "Skill(ctx:enable)";
function driftedEntries(settings, a) {
  const out = [];
  const deny = isObj2(settings.permissions) && Array.isArray(settings.permissions.deny) ? settings.permissions.deny : [];
  for (const t of a.owned.deny) if (!deny.includes(t)) out.push(`tool:${t}`);
  const ep = isObj2(settings.enabledPlugins) ? settings.enabledPlugins : {};
  for (const p of Object.keys(a.owned.plugins)) if (ep[p] !== false) out.push(`plugin:${p}`);
  const so = isObj2(settings.skillOverrides) ? settings.skillOverrides : {};
  for (const [k, v] of Object.entries(a.owned.skills)) if (so[k] !== v) out.push(`skill:${k}`);
  return out;
}

// src/doctor.ts
function profileStatus(root) {
  const a = loadApplied(root);
  const owned = ownedRefs(a).length;
  const pre = a.preexisting.deny.length + Object.keys(a.preexisting.plugins).length + Object.keys(a.preexisting.skills).length;
  if (!owned && !a.history.length) return "not applied (run /ctx:setup)";
  const local = loadScopes(root).find((s) => s.scope === "local");
  if (local?.error) return `settings.local.json is INVALID (${local.error}); ctx entries can't be checked`;
  const drift = driftedEntries(local?.data ?? {}, a);
  const last = a.history.at(-1);
  const parts = [`${owned} entries owned by ctx`, `${pre} preexisting`];
  if (last) parts.push(`last change: ${last.action}, ${age(last.at)}`);
  if (a.verified) parts.push(`verified ${(a.verified.beforeTokens / 1e3).toFixed(1)}K -> ${(a.verified.afterTokens / 1e3).toFixed(1)}K`);
  parts.push(drift.length ? `DRIFT: ${drift.join(", ")} changed outside ctx` : "in force");
  return parts.join("; ");
}
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
    for (const c of candidates()) out.push(`    - ${c.path} (${c.source})${fs7.existsSync(c.path) ? " [exists, --version failed]" : ""}`);
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
    const n = fs7.readdirSync(d).filter((f) => f.endsWith(".jsonl")).length;
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
  out.push(`  profile: ${profileStatus(root)}`);
  out.push(`  ctx home: ${ctxHome()}`);
  return out.join("\n");
}

// src/protect.ts
import fs8 from "node:fs";
import path7 from "node:path";
var ALWAYS = ["Read", "Edit", "Write", "Glob", "Grep", "Skill", "ToolSearch", "AskUserQuestion", "EndConversation"];
function claudeMdMentions(word) {
  for (const f of [path7.join(claudeDir(), "CLAUDE.md")]) {
    try {
      const text = fs8.readFileSync(f, "utf8");
      if (text.includes(word)) return true;
      for (const m of text.matchAll(/^@(\S+)/gm)) {
        try {
          if (fs8.readFileSync(path7.resolve(path7.dirname(f), m[1]), "utf8").includes(word)) return true;
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
  const off2 = [];
  for (const t of trims.tools) off2.push(`tool ${t.name} (${fmtK1(m.items[`tool:${t.name}`]?.deltaTokens ?? 0)}${t.scope !== "local" ? `, ${t.scope}` : ""}${usedNote(`tool:${t.name}`)})`);
  for (const p of trims.plugins) off2.push(`plugin ${p.id.split("@")[0]} (${fmtK1(m.items[`plugin:${p.id}`]?.deltaTokens ?? 0)}${p.scope !== "local" ? `, ${p.scope}` : ""})`);
  const offSkills = trims.skills.filter((s) => s.level === "off");
  for (const s of offSkills) off2.push(`skill ${s.name} (off)`);
  out.push(off2.length ? wrapJoin("Switched off:  ", off2) : "Switched off:  nothing");
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
  out.push(`ctx profile: ${profileStatus(root)}`);
  out.push(`Measured ${m.measuredAt.slice(0, 16).replace("T", " ")} UTC \xB7 /ctx:trim to re-plan \xB7 /ctx:on <item> \xB7 /ctx:undo to revert`);
  return out.join("\n");
}

// src/commands.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import fs9 from "node:fs";
import path10 from "node:path";

// src/plan.ts
import path9 from "node:path";

// src/deps.json
var deps_default = {
  _comment: "Spec \xA77.2. 'skills': skills that need the item; they go to name-only with it, and if one is used or kept, the item is kept. 'note': shown in the capability index.",
  "tool:Artifact": { skills: ["artifact-design", "artifact-diagramming", "artifact-capabilities"] },
  "tool:ScheduleWakeup": { skills: ["loop"], note: "needed by /loop" },
  "tool:ReportFindings": { skills: ["code-review"], note: "needed by /code-review" }
};

// src/profile.ts
import path8 from "node:path";
function profilePath(root) {
  return path8.join(projectStateDir(root), "project-profile.json");
}
function loadProfile(root) {
  return readJson(profilePath(root));
}
var strArray = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : void 0;
function setProfile(root, patchJson) {
  let patch;
  try {
    patch = JSON.parse(patchJson);
  } catch (e) {
    throw new Error(`profile --set expects JSON: ${e.message}`);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("profile --set expects a JSON object");
  const cur = loadProfile(root) ?? { createdAt: (/* @__PURE__ */ new Date()).toISOString() };
  const next = { ...cur };
  if (typeof patch.summary === "string") next.summary = patch.summary.trim();
  for (const k of ["stack", "services", "workTypes", "keep"]) {
    const v = strArray(patch[k]);
    if (v) next[k] = v;
  }
  next.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  writeJson(profilePath(root), next);
  return next;
}
var WORK_TYPE_KEYWORDS = {
  docs: ["docx", "pdf", "pptx", "xlsx", "docs", "google-workspace", "artifact", "dataviz"],
  documents: ["docx", "pdf", "pptx", "xlsx", "docs", "google-workspace"],
  media: ["watch", "video", "image", "dataviz"],
  deploys: ["deploy", "cloudflare", "wrangler", "vercel", "docker", "schedule"],
  research: ["deep-research", "web", "browser", "chrome"],
  web: ["browser", "chrome", "artifact", "built-in-browser"],
  data: ["xlsx", "dataviz", "pdf"],
  code: ["code-review", "security-review", "simplify"]
};
function profileKeywords(p) {
  if (!p) return [];
  const out = /* @__PURE__ */ new Set();
  for (const s of [...p.stack ?? [], ...p.services ?? []]) for (const w of s.toLowerCase().split(/[^a-z0-9-]+/)) if (w.length >= 3) out.add(w);
  for (const w of p.workTypes ?? []) for (const k of WORK_TYPE_KEYWORDS[w.toLowerCase()] ?? [w.toLowerCase()]) out.add(k);
  return [...out];
}

// src/plan.ts
var DEPS = deps_default;
function planPath(root) {
  return path9.join(projectStateDir(root), "plan.json");
}
function loadPlan(root) {
  return readJson(planPath(root));
}
function savePlan(root, p) {
  writeJson(planPath(root), p);
}
function nameOf(id) {
  return id.slice(id.indexOf(":") + 1);
}
function pluginName(id) {
  return nameOf(id).split("@")[0];
}
function pluginSessions(ledger, plugin) {
  if (!ledger) return 0;
  let n = 0;
  for (const [id, u] of Object.entries(ledger.items)) {
    if (id.startsWith(`skill:${plugin}:`) || id.startsWith(`agent:${plugin}:`)) n = Math.max(n, u.sessionsUsed);
  }
  return n;
}
function matchesSignal(id, keywords) {
  const name = nameOf(id).toLowerCase();
  return keywords.find((k) => name.includes(k) || k.length >= 4 && k.includes(name));
}
function buildPlan(m, ledger, profile, opts) {
  const min = opts.minTokens ?? 200;
  const rareMin = opts.rareMinTokens ?? 2e3;
  const keywords = profileKeywords(profile);
  const window = ledger?.sessions.length ?? 0;
  const items = [];
  const notes = [];
  const used = (id) => ledger?.items[id]?.sessionsUsed ?? 0;
  const windowStart = ledger?.sessions.length ? ledger.sessions.reduce((a, s) => s.mtime < a ? s.mtime : a, ledger.sessions[0].mtime) : "";
  const reenabled = (id) => (ledger?.reenables[id] ?? []).filter((ts) => ts.slice(0, 24) >= windowStart).length;
  for (const [id, it] of Object.entries(m.items)) {
    if (it.kind === "memory") continue;
    if (it.kind === "mcp") {
      const n = used(id);
      items.push(n ? { id, kind: "mcp", class: "used", action: "none", saveTokens: 0, reason: `used in ${n} of ${window} sessions` } : {
        id,
        kind: "mcp",
        class: "mcp",
        action: "suggest",
        saveTokens: 0,
        group: "mcp",
        reason: "not used here; tools are deferred, so only names and instructions cost tokens. Toggle with /mcp"
      });
      continue;
    }
    const kind = it.kind;
    const full = it.deltaTokens;
    const soft = it.softDeltaTokens ?? 0;
    const sessions = kind === "plugin" ? pluginSessions(ledger, pluginName(id)) : used(id);
    const push = (c, action, reason, group) => {
      const saveTokens = action === "none" ? 0 : kind === "skill" && action === "soft" ? soft : full;
      items.push({ id, kind, class: c, action, saveTokens, reason, ...group ? { group } : {} });
    };
    const offGroup = kind === "tool" ? "tools" : kind === "plugin" ? "plugins" : "skills-off";
    if (it.unmeasured) {
      push("negligible", "none", `not measured (${it.unmeasured})`);
      continue;
    }
    if (opts.protectedIds.has(id)) {
      push("protected", "none", "protected");
      continue;
    }
    if (profile?.keep?.includes(id)) {
      push("kept", "none", "pinned in the project profile");
      continue;
    }
    if (reenabled(id) >= 1) {
      push("used", "none", `re-enabled ${reenabled(id) === 1 ? "once" : `${reenabled(id)} times`} recently`);
      continue;
    }
    if (sessions > 0) {
      if (kind !== "skill" && full >= rareMin && sessions <= 1 && window >= 2) {
        push("rare", "off", `used in only ${sessions} of ${window} sessions (opt-in)`, "rare");
      } else {
        push("used", "none", `used in ${sessions} of ${window} sessions`);
      }
      continue;
    }
    const signal = matchesSignal(id, keywords);
    if (signal) {
      if (kind === "skill" && soft >= min / 4) push("likely", "soft", `matches project signal "${signal}"`, "skills");
      else push("likely", "none", `matches project signal "${signal}"`);
      continue;
    }
    const global = kind === "skill" ? globalSkillCount(ledger ?? emptyLedger(), nameOf(id)) : kind === "plugin" ? ledger?.global.pluginUsage[nameOf(id)]?.usageCount ?? 0 : 0;
    if (global > 0) {
      if (kind === "plugin" && full >= min / 2) {
        push("foreign", "off", `used in other projects (${global}x), never here`, "plugins");
        continue;
      }
      if (kind === "skill" && soft > 0 && full >= min / 4) {
        push("foreign", "soft", `used in other projects (${global}x), never here`, "skills");
        continue;
      }
      push("negligible", "none", `used elsewhere; ${fmtK1(full)} here`);
      continue;
    }
    if (full >= min) {
      if (kind === "skill") {
        if (opts.aggressive) push("unused", "off", "never used", "skills-off");
        else push("unused", "soft", "never used", "skills");
      } else {
        push("unused", "off", "never used", offGroup);
      }
      continue;
    }
    push("negligible", "none", `never used, ${fmtK1(full)}`);
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const [dep, d] of Object.entries(DEPS)) {
    const it = byId.get(dep);
    if (!it || it.action === "none") continue;
    const keeper = (d.skills ?? []).find((s) => {
      const si = byId.get(`skill:${s}`);
      return si && ["protected", "kept", "used", "likely"].includes(si.class) && si.action === "none";
    });
    if (keeper) {
      Object.assign(it, { class: "needed", action: "none", saveTokens: 0, reason: `needed by skill ${keeper}` });
      delete it.group;
      continue;
    }
    for (const s of d.skills ?? []) {
      const si = byId.get(`skill:${s}`);
      if (si && si.action === "none" && !["protected", "kept", "used"].includes(si.class)) {
        const mi = m.items[`skill:${s}`];
        Object.assign(si, { action: "soft", saveTokens: mi?.softDeltaTokens ?? 0, reason: `goes with ${dep} (dependency)`, group: it.group });
      }
    }
  }
  const trimmed = items.filter((i) => i.action === "off" || i.action === "soft");
  if (!window) notes.push("No usage history for this project yet: every item counts as unused. Review the plan carefully.");
  if (trimmed.some((i) => i.group === "rare")) notes.push('The "rare" group holds items you used recently; it is applied only if you select it.');
  return {
    project: m.project,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    measuredAt: m.measuredAt,
    ccVersion: m.ccVersion,
    windowSessions: window,
    aggressive: !!opts.aggressive,
    minTokens: min,
    reviewed: false,
    notes,
    items: items.sort((a, b) => b.saveTokens - a.saveTokens || a.id.localeCompare(b.id))
  };
}
function emptyLedger() {
  return { project: "", builtAt: "", sessionsScanned: 0, window: { sessions: 0 }, sessions: [], items: {}, reenables: {}, global: { skillUsage: {}, pluginUsage: {} } };
}
var RANK = { none: 0, suggest: 0, soft: 1, off: 2 };
function reviewPlan(draft, reviewJson) {
  let parsed;
  try {
    parsed = JSON.parse(reviewJson);
  } catch (e) {
    throw new Error(`plan --set expects JSON: ${e.message}`);
  }
  const plan = JSON.parse(JSON.stringify(draft));
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const rejected = [];
  const changed = [];
  for (const r of parsed.items ?? []) {
    const id = String(r.id ?? "");
    const action = String(r.action ?? "");
    const it = byId.get(id);
    if (!it) {
      rejected.push(`${id}: not in the plan`);
      continue;
    }
    if (!(action in RANK) || action === "suggest") {
      rejected.push(`${id}: unknown action "${action}"`);
      continue;
    }
    if (action === it.action) continue;
    const ok = RANK[action] < RANK[it.action] || it.action === "none" && action === "soft" && it.kind === "skill" && it.class !== "protected";
    if (!ok) {
      rejected.push(`${id}: ${it.action} -> ${action} would trim more than the rules allow`);
      continue;
    }
    if (action === "soft" && it.kind !== "skill") {
      rejected.push(`${id}: only skills have a soft level`);
      continue;
    }
    changed.push(`${id}: ${it.action} -> ${action}`);
    it.action = action;
    it.reason = typeof r.reason === "string" && r.reason ? `review: ${r.reason}` : `review: ${it.action}`;
    if (action === "none") {
      it.saveTokens = 0;
      delete it.group;
    }
    if (action === "soft") {
      it.group = "skills";
    }
  }
  if (Array.isArray(parsed.notes)) plan.notes.push(...parsed.notes.filter((n) => typeof n === "string").map((n) => `review: ${n}`));
  plan.reviewed = true;
  return { plan, rejected, changed };
}
var GROUP_LABEL = {
  tools: "Deny unused built-in tools",
  plugins: "Switch off plugins not used here",
  skills: "Unused skills to name-only (still callable by name)",
  "skills-off": "Unused skills fully off (aggressive)",
  rare: "Costly items used only once recently (opt-in)",
  mcp: "MCP servers not used here (suggestion; toggle with /mcp)"
};
function groupSummary(plan) {
  const order = ["tools", "plugins", "skills", "skills-off", "rare", "mcp"];
  return order.map((g) => {
    const items = plan.items.filter((i) => i.group === g && i.action !== "none");
    return { group: g, items, tokens: items.reduce((a, i) => a + i.saveTokens, 0) };
  }).filter((g) => g.items.length);
}
function renderPlan(plan, m) {
  const out = [];
  out.push(`ctx plan: ${projectKey(plan.project)}   (untrimmed ${fmtK1(m.reference.correctedTokens)}, usage window ${plan.windowSessions} sessions${plan.aggressive ? ", aggressive" : ""}${plan.reviewed ? ", reviewed" : ""})`);
  out.push("");
  for (const g of groupSummary(plan)) {
    const est = g.group === "mcp" ? "" : `   est. -${fmtK1(g.tokens)}`;
    out.push(`[${g.group}] ${GROUP_LABEL[g.group]}${est}`);
    for (const i of g.items) {
      out.push(`  ${i.id.padEnd(38)} ${i.group === "mcp" ? "      " : fmtK1(i.saveTokens).padStart(6)}  ${i.action.padEnd(5)} ${i.reason}`.slice(0, 100));
    }
    out.push("");
  }
  const keep = plan.items.filter((i) => i.action === "none" && i.kind !== "mcp" && ["used", "protected", "kept", "needed", "likely"].includes(i.class));
  out.push(wrapJoin("Kept on: ", keep.map((i) => `${nameOf(i.id)} (${i.class})`)));
  for (const n of plan.notes) out.push(`Note: ${n}`);
  out.push("Estimates come from single-item measurements and are not additive; apply reports the verified total.");
  return out.join("\n");
}

// src/resolve.ts
function knownIds(m, scopes, applied) {
  const ids = /* @__PURE__ */ new Set();
  for (const id of Object.keys(m?.items ?? {})) if (!id.startsWith("memory:")) ids.add(id);
  for (const t of m?.upfrontTools ?? []) ids.add(`tool:${t}`);
  const trims = activeTrims(scopes);
  for (const t of trims.tools) ids.add(`tool:${t.name}`);
  for (const p of trims.plugins) ids.add(`plugin:${p.id}`);
  for (const s of trims.skills) ids.add(`skill:${s.name}`);
  for (const t of applied.owned.deny) ids.add(`tool:${t}`);
  for (const p of Object.keys(applied.owned.plugins)) ids.add(`plugin:${p}`);
  for (const s of Object.keys(applied.owned.skills)) ids.add(`skill:${s}`);
  return [...ids];
}
function resolveItem(query, ids) {
  const q = query.trim();
  const ql = q.toLowerCase().replace(/^anthropic-skills:/, "");
  const exact = ids.find((id) => id === q);
  if (exact) return { id: exact, candidates: [exact] };
  const ci = ids.filter((id) => id.toLowerCase() === ql);
  if (ci.length === 1) return { id: ci[0], candidates: ci };
  const byName = ids.filter((id) => {
    const name = id.slice(id.indexOf(":") + 1).toLowerCase();
    return name === ql || name.split("@")[0] === ql;
  });
  if (byName.length === 1) return { id: byName[0], candidates: byName };
  if (byName.length > 1) {
    return { candidates: byName };
  }
  const partial = ids.filter((id) => id.toLowerCase().includes(ql));
  if (partial.length === 1) return { id: partial[0], candidates: partial };
  return { candidates: partial.slice(0, 12) };
}

// src/commands.ts
var DEFAULT_GROUPS = ["tools", "plugins", "skills"];
function refsForPlan(plan, groups) {
  const refs = [];
  for (const i of plan.items) {
    if (!i.group || !groups.includes(i.group) || i.action !== "off" && i.action !== "soft") continue;
    const name = i.id.slice(i.id.indexOf(":") + 1);
    if (i.kind === "tool" && i.action === "off") refs.push({ kind: "tool", name });
    else if (i.kind === "plugin" && i.action === "off") refs.push({ kind: "plugin", id: name });
    else if (i.kind === "skill") refs.push({ kind: "skill", name, level: i.action === "off" ? "off" : "name-only" });
  }
  return refs;
}
function gitIgnoreStatus(root) {
  try {
    const r = spawnSync2("git", ["-C", root, "check-ignore", "-q", path10.join(".claude", "settings.local.json")], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      timeout: 1e4
    });
    return r.status === 0 ? "ignored" : r.status === 1 ? "not-ignored" : "no-repo";
  } catch {
    return "no-repo";
  }
}
function addGitExclude(root) {
  const r = spawnSync2("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { shell: false, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return false;
  const file = path10.resolve(root, r.stdout.trim());
  fs9.mkdirSync(path10.dirname(file), { recursive: true });
  const cur = fs9.existsSync(file) ? fs9.readFileSync(file, "utf8") : "";
  if (!cur.split(/\r?\n/).includes(".claude/settings.local.json")) {
    fs9.appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}.claude/settings.local.json
`);
  }
  return true;
}
function allowEnable(root, remove, out) {
  const ref = { kind: "allow", rule: ENABLE_RULE };
  const res = writeSettings(root, remove ? "disallow enable" : "allow enable", (s, a) => {
    if (remove) return clearEntry(s, a, ref) === "removed" ? [`removed allow ${ENABLE_RULE}`] : [];
    const c = setEntry(s, a, ref);
    return c ? [c] : [];
  });
  if (!res.changes.length) out(remove ? `${ENABLE_RULE} isn't set by ctx; nothing removed.` : `${ENABLE_RULE} is already allowed.`);
  else out(remove ? `Removed ${ENABLE_RULE}: Claude will ask before switching items back on.` : `Added ${ENABLE_RULE} to ${res.file}: Claude can switch trimmed items back on when a task needs them, without asking.`);
  return 0;
}
async function apply(root, opts, out) {
  const plan = opts.planFile ? readJson(path10.resolve(opts.planFile)) : loadPlan(root);
  if (!plan) {
    out("No plan yet. Run: ctx plan");
    return 2;
  }
  const m = loadMeasurement(root);
  if (!m) {
    out("No measurement yet. Run: ctx measure");
    return 2;
  }
  const groups = opts.groups ?? DEFAULT_GROUPS;
  const desired = refsForPlan(plan, groups);
  const desiredKeys = new Set(desired.map(refKey));
  const mutation = (s, a) => {
    const changes = [];
    const pinned = new Set(a.pinnedOff ?? []);
    for (const r of ownedRefs(a)) {
      if (r.kind === "allow" || desiredKeys.has(refKey(r)) || pinned.has(refKey(r))) continue;
      if (clearEntry(s, a, r) === "removed") changes.push(`removed ${describeRef(r)} (no longer planned)`);
    }
    for (const r of desired) {
      const c = setEntry(s, a, r);
      if (c) changes.push(c);
    }
    if (opts.allowEnable) {
      const c = setEntry(s, a, { kind: "allow", rule: ENABLE_RULE });
      if (c) changes.push(`${c} (Claude may switch items back on when a task needs them)`);
    }
    return changes;
  };
  if (!opts.yes) {
    const settings = readJson(path10.join(root, ".claude", "settings.local.json")) ?? {};
    const changes = mutation(JSON.parse(JSON.stringify(settings)), JSON.parse(JSON.stringify(loadApplied(root))));
    out(`Dry run (groups: ${groups.join(", ")}). ${changes.length} change(s) to .claude/settings.local.json:`);
    for (const c of changes) out(`  ${c}`);
    out("Run again with --yes to write them.");
    return 0;
  }
  const res = writeSettings(root, `apply ${groups.join(",")}`, mutation);
  const skipped = res.changes.filter((c) => c.startsWith("skipped"));
  const applied = res.changes.filter((c) => !c.startsWith("skipped"));
  out(applied.length ? `Wrote ${applied.length} change(s) to ${res.file} (backup ${res.backup}).` : "Settings already match the plan; nothing written.");
  for (const c of res.changes) out(`  ${c}`);
  if (skipped.length) out("Skipped entries hold a value you set yourself; ctx leaves them alone.");
  const git = gitIgnoreStatus(root);
  if (git === "not-ignored") {
    if (opts.gitExclude && addGitExclude(root)) out("Added .claude/settings.local.json to .git/info/exclude.");
    else out("Warning: .claude/settings.local.json is not git-ignored. Re-run with --git-exclude to add it to .git/info/exclude.");
  }
  if (opts.verify !== false) await verifyAndRecord(root, m, out);
  return 0;
}
async function verifyAndRecord(root, m, out) {
  const before = m.current.correctedTokens;
  try {
    const now = await verifyRun(root, {}, m.reference, m.skillsQuirk);
    const a = loadApplied(root);
    a.verified = { at: (/* @__PURE__ */ new Date()).toISOString(), beforeTokens: before, afterTokens: now.correctedTokens, rawAfterTokens: now.totalTokens };
    writeJson(appliedPath(root), a);
    const fresh = loadMeasurement(root);
    if (fresh) {
      fresh.current = now;
      writeJson(measurementPath(root), fresh);
    }
    out(`Upfront context for new sessions: ${fmtK(before)} -> ${fmtK(now.correctedTokens)} (untrimmed ${fmtK(m.reference.correctedTokens)})` + (m.skillsQuirk && now.totalTokens !== now.correctedTokens ? `; /context will show ${fmtK(now.totalTokens)}` : "") + ".");
    out("Start a new session (/clear or a new chat) to use it. This session keeps the tools it started with.");
  } catch (e) {
    out(`Verification run failed: ${e.message}. Settings were written; run ctx measure to check.`);
  }
}
function refForId(id, level = "name-only") {
  const name = id.slice(id.indexOf(":") + 1);
  if (id.startsWith("tool:")) return { kind: "tool", name };
  if (id.startsWith("plugin:")) return { kind: "plugin", id: name };
  if (id.startsWith("skill:")) return { kind: "skill", name, level };
  return void 0;
}
function resolveOrExplain(root, query, out) {
  const m = loadMeasurement(root);
  const ids = knownIds(m, loadScopes(root), loadApplied(root));
  const r = resolveItem(query, ids);
  if (r.id) return r.id;
  if (r.candidates.length) {
    out(`"${query}" matches several items; use one of:`);
    for (const c of r.candidates) out(`  ${c}`);
  } else {
    out(`No item named "${query}". Known items include: ${ids.filter((i) => !i.startsWith("mcp:")).slice(0, 12).join(", ")} ...`);
  }
  return void 0;
}
function recordReenable(root, id, reason) {
  const l = loadLedger(root) ?? {
    project: projectKey(root),
    builtAt: (/* @__PURE__ */ new Date()).toISOString(),
    sessionsScanned: 0,
    window: { sessions: 10 },
    sessions: [],
    items: {},
    reenables: {},
    global: { skillUsage: {}, pluginUsage: {} }
  };
  (l.reenables[id] ??= []).push((/* @__PURE__ */ new Date()).toISOString() + (reason ? ` ${reason.slice(0, 120)}` : ""));
  l.reenables[id] = l.reenables[id].slice(-10);
  writeJson(ledgerPath(root), l);
}
function howItApplies(id, m) {
  const name = id.slice(id.indexOf(":") + 1);
  if (id.startsWith("tool:")) {
    const lines = [
      `${name} can be called from now on, but it stays out of this session's tool list until /clear or a new session.`
    ];
    const schema = m?.toolSchemas?.[name];
    if (schema) {
      const s = JSON.stringify(schema);
      lines.push(`${name} input schema (call the tool with arguments matching it):`);
      lines.push(s.length > 4e3 ? `${s.slice(0, 4e3)}... (truncated)` : s);
    }
    return lines;
  }
  if (id.startsWith("plugin:")) return ["Run /reload-plugins to load it in this session (new sessions load it automatically)."];
  if (id.startsWith("skill:")) return [`Skill ${name} can be invoked by name now; its full description returns in new sessions.`];
  return [];
}
function on(root, query, opts, out) {
  let id = resolveOrExplain(root, query, out);
  if (!id) return 2;
  if (id.startsWith("mcp:")) {
    out(`${id} is an MCP server. Toggle it with /mcp (ctx doesn't edit ~/.claude.json).`);
    return 0;
  }
  const m = loadMeasurement(root);
  const pluginSkill = id.startsWith("skill:") && m?.skills.find((s) => `skill:${s.name}` === id)?.plugin;
  if (pluginSkill) {
    const pid = Object.keys(m?.items ?? {}).find((k) => k.startsWith(`plugin:${pluginSkill}@`));
    if (pid) {
      out(`${id} belongs to plugin ${pid.slice(7)}; switching the plugin on.`);
      id = pid;
    }
  }
  const ref = refForId(id);
  if (!ref) {
    out(`Can't switch ${id} on.`);
    return 2;
  }
  let result = "absent";
  const res = writeSettings(root, `on ${id}`, (s, a) => {
    const r = clearEntry(s, a, ref, !!opts.force);
    result = r;
    if (r === "removed") {
      a.pinnedOff = (a.pinnedOff ?? []).filter((k) => k !== refKey(ref));
      return [`removed ${describeRef(ref)}`];
    }
    return [];
  });
  if (result === "removed") {
    out(`${id} is on again (${res.file}, backup ${res.backup}).`);
    for (const l of howItApplies(id, m)) out(l);
    recordReenable(root, id, opts.reason);
    if (id.startsWith("tool:") && process.env.CLAUDECODE) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    return 0;
  }
  if (result === "not-owned") {
    out(`${id} is switched off in .claude/settings.local.json, but not by ctx. Run "ctx on ${query} --force" to remove that entry (a backup is kept).`);
    return 1;
  }
  const scopes = loadScopes(root);
  const where = ref.kind === "tool" ? findRule(scopes, "deny", ref.name) : ref.kind === "plugin" ? findRule(scopes, "plugin", ref.id) : ref.kind === "skill" ? findRule(scopes, "skill", ref.name) : [];
  const other = where.filter((s) => s.scope !== "local");
  if (other.length) {
    const key = ref.kind === "tool" ? `permissions.deny "${ref.name}"` : ref.kind === "plugin" ? `enabledPlugins["${ref.id}"]` : ref.kind === "skill" ? `skillOverrides["${ref.name}"]` : "";
    for (const s of other) out(`${id} is switched off in ${s.path} (${s.scope} settings), key ${key}. ctx doesn't edit that file; change it there.`);
    return 1;
  }
  out(`${id} is already on.`);
  return 0;
}
function off(root, query, opts, out) {
  const id = resolveOrExplain(root, query, out);
  if (!id) return 2;
  if (id.startsWith("mcp:")) {
    out(`${id} is an MCP server. Toggle it with /mcp.`);
    return 0;
  }
  const m = loadMeasurement(root);
  if (id.startsWith("skill:") && m?.skills.find((s) => `skill:${s.name}` === id)?.plugin) {
    out(`${id} is a plugin skill; plugin skills can't be switched off one by one. Switch off its plugin instead.`);
    return 1;
  }
  const prot = protectedIds({ ledger: loadLedger(root), keep: loadProfile(root)?.keep });
  if (prot.has(id) && !opts.force) {
    out(`${id} is protected${id === "tool:Skill" || id === "tool:ToolSearch" ? " (denying it makes context larger)" : ""}. Use --force to switch it off anyway.`);
    return 1;
  }
  const ref = refForId(id, opts.level ?? "name-only");
  if (!ref) {
    out(`Can't switch ${id} off.`);
    return 2;
  }
  const res = writeSettings(root, `off ${id}`, (s, a) => {
    const c = setEntry(s, a, ref);
    if (c && !c.startsWith("skipped")) a.pinnedOff = [.../* @__PURE__ */ new Set([...a.pinnedOff ?? [], refKey(ref)])];
    return c ? [c] : [];
  });
  if (!res.changes.length) {
    out(`${id} is already off.`);
    return 0;
  }
  if (res.changes[0].startsWith("skipped")) {
    out(res.changes[0]);
    return 1;
  }
  const save = m?.items[id];
  out(`${describeRef(ref)} written to ${res.file} (backup ${res.backup})${save ? `; saves about ${fmtK(ref.kind === "skill" && ref.level === "name-only" ? save.softDeltaTokens ?? 0 : save.deltaTokens)} per new session` : ""}.`);
  if (ref.kind === "plugin") out("Takes effect in new sessions, or run /reload-plugins.");
  else out("Takes effect in new sessions.");
  return 0;
}
function undo2(root, all, out) {
  try {
    const r = undo(root, all);
    out(all ? r.deleted ? "Restored the original state: .claude/settings.local.json did not exist before ctx, so it was removed." : `Restored the original .claude/settings.local.json (backup ${r.restored}).` : `Restored .claude/settings.local.json from backup ${r.restored}${r.deleted ? " (the file did not exist then, so it was removed)" : ""}.`);
    if (r.manualEditsSaved) out(`The file had edits made after ctx's last write; they were saved to backups/${r.manualEditsSaved}.`);
    out("New sessions use the restored settings.");
    return 0;
  } catch (e) {
    out(e.message);
    return 1;
  }
}

// src/hook.ts
import { spawn as spawn2 } from "node:child_process";
import fs10 from "node:fs";
var DEPS2 = deps_default;
var INDEX_MAX_CHARS = 1500;
var INDEX_HEADER = "Switched off in this project to save context (ask or use /ctx:enable to turn one on):";
function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs10.readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function hardOffEntries(m, scopes) {
  const local = scopes.filter((s) => s.scope === "local");
  const trims = activeTrims(local);
  const out = [];
  for (const t of trims.tools) {
    const id = `tool:${t.name}`;
    const note = DEPS2[id]?.note;
    const desc = m?.items[id]?.description ?? "";
    out.push({ label: `${t.name} tool`, desc: note ? `${desc}${desc ? " " : ""}(${note})` : desc });
  }
  for (const p of trims.plugins) {
    const name = p.id.split("@")[0];
    out.push({ label: `${name} plugin`, desc: m?.items[`plugin:${p.id}`]?.description ?? "" });
  }
  for (const s of trims.skills) {
    if (s.level !== "off" && s.level !== "user-invocable-only") continue;
    out.push({ label: `${s.name} skill`, desc: m?.skillDescriptions?.[s.name] ?? "" });
  }
  return out;
}
function capabilityIndex(entries) {
  if (!entries.length) return void 0;
  const lines = [INDEX_HEADER];
  let chars = INDEX_HEADER.length;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const line = `- ${e.label}${e.desc ? `: ${e.desc}` : ""}`;
    if (chars + line.length > INDEX_MAX_CHARS) {
      lines.push(`- ... and ${entries.length - i} more (see /ctx:report)`);
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join("\n");
}
function sessionStart(root) {
  const m = loadMeasurement(root);
  const scopes = loadScopes(root);
  const applied = loadApplied(root);
  const index = capabilityIndex(hardOffEntries(m, scopes));
  const out = {};
  if (index) out.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: index };
  const owned = ownedRefs(applied).length;
  const trims = activeTrims(scopes.filter((s) => s.scope === "local"));
  const nOff = trims.tools.length + trims.plugins.length + trims.skills.length;
  if (owned && m) {
    out.systemMessage = `ctx: lean profile active (${fmtK(m.current.correctedTokens)} upfront, ${nOff} items trimmed). /ctx:report for details.`;
  } else if (m && !owned) {
    const threshold = Number(process.env.CTX_SUGGEST_THRESHOLD ?? 2e4);
    if (m.current.correctedTokens > threshold) {
      const ledger = loadLedger(root);
      const profile = loadProfile(root);
      const plan = buildPlan(m, ledger, profile, { protectedIds: protectedIds({ ledger, keep: profile?.keep }) });
      const save = groupSummary(plan).filter((g) => ["tools", "plugins", "skills"].includes(g.group)).reduce((a, g) => a + g.tokens, 0);
      if (save >= 1e3) out.systemMessage = `ctx: this project loads ${fmtK(m.current.correctedTokens)} upfront; /ctx:setup could cut ~${fmtK(save)}.`;
    }
  }
  return out;
}
function sessionEnd(root, cliPath) {
  if (!loadMeasurement(root) && !loadLedger(root)) return;
  const child = spawn2(process.execPath, [cliPath, "usage", "--quiet", "--project", root], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false
  });
  child.unref();
}

// src/cli.ts
var GROUPS = ["tools", "plugins", "skills", "skills-off", "rare"];
function parseGroups(v) {
  if (typeof v !== "string") return void 0;
  const gs = v.split(/[,\s]+/).filter(Boolean);
  const bad = gs.filter((g) => !GROUPS.includes(g));
  if (bad.length) throw new Error(`unknown group(s): ${bad.join(", ")} (valid: ${GROUPS.join(", ")})`);
  return gs;
}
var HELP = `ctx: measure and trim what each Claude Code session loads.

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
  hook session-start | session-end          hook entry points (cached data only)
Items: tool:Artifact, plugin:cloudflare@cloudflare, skill:docx, or just a name ("artifact").
Global: --project <dir> (default: CLAUDE_PROJECT_DIR or cwd)`;
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
      if (a.flags.quiet) return 0;
      if (a.flags.json) {
        console.log(JSON.stringify(l, null, 2));
        return 0;
      }
      console.log(`Scanned ${l.sessionsScanned} transcripts; ${l.sessions.length} sessions with assistant turns in the window.`);
      const top = Object.entries(l.items).sort((x, y) => y[1].sessionsUsed - x[1].sessionsUsed || y[1].calls - x[1].calls);
      for (const [id, u] of top.slice(0, 30)) console.log(`  ${id.padEnd(44)} ${String(u.sessionsUsed).padStart(3)} sessions ${String(u.calls).padStart(5)} calls  last ${u.lastUsedAt?.slice(0, 16) ?? "-"}`);
      return 0;
    }
    case "hook": {
      try {
        const input = readHookInput();
        const hookRoot = resolveProjectRoot(typeof a.flags.project === "string" ? a.flags.project : process.env.CLAUDE_PROJECT_DIR ?? input.cwd);
        if (a.positional[0] === "session-start") {
          const out = sessionStart(hookRoot);
          if (out.systemMessage || out.hookSpecificOutput) process.stdout.write(JSON.stringify(out));
        } else if (a.positional[0] === "session-end") {
          sessionEnd(hookRoot, process.argv[1]);
        }
      } catch (e) {
        if (process.env.CTX_DEBUG) console.error(e);
      }
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
    case "profile": {
      if (typeof a.flags.set === "string") {
        const p2 = setProfile(root, a.flags.set);
        console.log(JSON.stringify(p2, null, 2));
        return 0;
      }
      const p = loadProfile(root);
      console.log(p ? JSON.stringify(p, null, 2) : `No project profile yet. Set one with: ctx profile --set '{"summary":"...","services":[],"workTypes":["code"]}'`);
      return 0;
    }
    case "plan": {
      let m = loadMeasurement(root);
      if (!m) {
        log("No measurement yet; measuring now...");
        m = await measure(root, { log });
      }
      if (typeof a.flags.set === "string") {
        const draft = loadPlan(root);
        if (!draft) {
          console.error("No plan to review. Run: ctx plan");
          return 2;
        }
        const r = reviewPlan(draft, a.flags.set);
        savePlan(root, r.plan);
        for (const c of r.changed) console.log(`changed  ${c}`);
        for (const c of r.rejected) console.log(`rejected ${c}`);
        console.log(renderPlan(r.plan, m));
        return r.rejected.length ? 1 : 0;
      }
      const l = loadLedger(root) ?? await buildLedger(root);
      const profile = loadProfile(root);
      const minTokens = typeof a.flags["min-tokens"] === "string" ? parseInt(a.flags["min-tokens"], 10) : void 0;
      const plan = buildPlan(m, l, profile, {
        aggressive: !!a.flags.aggressive,
        minTokens: minTokens && minTokens > 0 ? minTokens : void 0,
        protectedIds: protectedIds({ ledger: l, keep: profile?.keep })
      });
      savePlan(root, plan);
      console.log(a.flags.json ? JSON.stringify(plan, null, 2) : renderPlan(plan, m));
      return 0;
    }
    case "apply":
      return apply(root, {
        groups: parseGroups(a.flags.groups),
        yes: !!a.flags.yes,
        planFile: typeof a.flags.plan === "string" ? a.flags.plan : void 0,
        verify: !a.flags["no-verify"],
        gitExclude: !!a.flags["git-exclude"],
        allowEnable: !!a.flags["allow-enable"]
      }, (s) => console.log(s));
    case "allow-enable":
      return allowEnable(root, !!a.flags.remove, (s) => console.log(s));
    case "on":
    case "off": {
      const q = a.positional.join(" ").trim();
      if (!q) {
        console.error(`Usage: ctx ${a.cmd} <item>`);
        return 2;
      }
      const out = (s) => console.log(s);
      if (a.cmd === "on") return on(root, q, { force: !!a.flags.force, reason: typeof a.flags.reason === "string" ? a.flags.reason : void 0 }, out);
      const level = a.flags.level === "off" ? "off" : "name-only";
      return off(root, q, { force: !!a.flags.force, level }, out);
    }
    case "undo":
      return undo2(root, a.positional[0] === "all", (s) => console.log(s));
    case "verify": {
      const m = loadMeasurement(root);
      if (!m) {
        console.error("No measurement yet. Run: ctx measure");
        return 2;
      }
      await verifyAndRecord(root, m, (s) => console.log(s));
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
