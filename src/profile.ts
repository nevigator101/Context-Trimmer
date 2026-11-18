import path from 'node:path';
import { projectStateDir, readJson, writeJson } from './paths.js';

/** Spec §5.4: the describe step's output. */
export interface ProjectProfile {
  summary?: string;
  stack?: string[];
  services?: string[];
  workTypes?: string[];
  /** Item ids the user pins on; never disabled. */
  keep?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export function profilePath(root: string): string { return path.join(projectStateDir(root), 'project-profile.json'); }

export function loadProfile(root: string): ProjectProfile | undefined {
  return readJson<ProjectProfile>(profilePath(root));
}

const strArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : undefined;

/** Merge a JSON patch into the profile, validating field types. */
export function setProfile(root: string, patchJson: string): ProjectProfile {
  let patch: Record<string, unknown>;
  try {
    patch = JSON.parse(patchJson) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`profile --set expects JSON: ${(e as Error).message}`);
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('profile --set expects a JSON object');
  const cur = loadProfile(root) ?? { createdAt: new Date().toISOString() };
  const next: ProjectProfile = { ...cur };
  if (typeof patch.summary === 'string') next.summary = patch.summary.trim();
  for (const k of ['stack', 'services', 'workTypes', 'keep'] as const) {
    const v = strArray(patch[k]);
    if (v) next[k] = v;
  }
  next.updatedAt = new Date().toISOString();
  writeJson(profilePath(root), next);
  return next;
}

/** Work types map to keywords that make matching items "likely" (spec §7.2). */
const WORK_TYPE_KEYWORDS: Record<string, string[]> = {
  docs: ['docx', 'pdf', 'pptx', 'xlsx', 'docs', 'google-workspace', 'artifact', 'dataviz'],
  documents: ['docx', 'pdf', 'pptx', 'xlsx', 'docs', 'google-workspace'],
  media: ['watch', 'video', 'image', 'dataviz'],
  deploys: ['deploy', 'cloudflare', 'wrangler', 'vercel', 'docker', 'schedule'],
  research: ['deep-research', 'web', 'browser', 'chrome'],
  web: ['browser', 'chrome', 'artifact', 'built-in-browser'],
  data: ['xlsx', 'dataviz', 'pdf'],
  code: ['code-review', 'security-review', 'simplify'],
};

/** Lower-case keywords that signal what the project needs. */
export function profileKeywords(p: ProjectProfile | undefined): string[] {
  if (!p) return [];
  const out = new Set<string>();
  for (const s of [...(p.stack ?? []), ...(p.services ?? [])]) for (const w of s.toLowerCase().split(/[^a-z0-9-]+/)) if (w.length >= 3) out.add(w);
  for (const w of p.workTypes ?? []) for (const k of WORK_TYPE_KEYWORDS[w.toLowerCase()] ?? [w.toLowerCase()]) out.add(k);
  return [...out];
}
