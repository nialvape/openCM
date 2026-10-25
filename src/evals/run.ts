import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { deepMerge, HarnessConfigSchema, type HarnessConfig, type ProjectConfig } from "../core/config.js";
import { harnessVersions } from "../core/context.js";
import { paths } from "../core/paths.js";
import { renderDraft } from "../pipeline/draft.js";
import { applyFormat, advance, type Outcome } from "../pipeline/flow.js";
import type { PipelineDeps } from "../pipeline/types.js";
import { getPullRequest } from "../sources/github/changes.js";
import { githubClient, GitHubError, type GitHubClient, type PullRequest, type PullRequestFile } from "../sources/github/client.js";
import { db as sharedDb, openDb } from "../store/db.js";
import { addEvent, getEventByPr, updateEvent } from "../store/events.js";
import { repoTools } from "../tools/repo.js";

const CaseSchema = z.object({
  name: z.string().optional(),
  /** A real PR of the project, read from GitHub. */
  pr: z.number().int().positive().optional(),
  /** Or a made-up PR, e.g. one whose description tries to steer the model. */
  fixture: z
    .object({
      pr: z.object({ number: z.number().int(), title: z.string(), body: z.string().nullable().default(null) }).passthrough(),
      files: z.array(z.object({ filename: z.string(), status: z.string().default("modified"), additions: z.number().default(1), deletions: z.number().default(0), patch: z.string().optional() })),
    })
    .optional(),
  expect: z
    .object({
      format: z.enum(["skip", "hold", "post", "thread"]).optional(),
      /** Case-insensitive substrings the content must contain / must not contain. */
      mention: z.array(z.string()).default([]),
      avoid: z.array(z.string()).default([]),
    })
    .prefault({}),
});
type EvalCase = z.infer<typeof CaseSchema> & { name: string; file: string };

export interface CaseResult {
  name: string;
  pr: number;
  expectedFormat?: string;
  format?: string;
  formatSource: "model" | "rule" | "unsure" | "failed";
  /** The analyst didn't run: the brief came from an earlier eval with the same analyst. */
  briefCached: boolean;
  formatCorrect?: boolean;
  checksPassed?: boolean;
  checkIssues: string[];
  criticScore?: number;
  revisions?: number;
  mentionMissing: string[];
  avoidFound: string[];
  costUsd: number;
  error?: string;
  content?: string;
}

export interface EvalReport {
  project: string;
  at: string;
  harness: Record<string, string>;
  /** Code the pipeline ran with: task texts and logic live in code, so they matter as much as prompts. */
  code?: { commit: string; dirty: boolean };
  models: Record<string, string>;
  decisionModel: string;
  /** False for a no-memory baseline run (--no-memory). */
  memory: boolean;
  cases: CaseResult[];
  summary: { formatAccuracy?: number; unsureRate?: number; checkPassRate?: number; meanCriticScore?: number; mentionRate?: number; avoidViolations: number; failures: number; costUsd: number };
}

function readCases(dir: string): EvalCase[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => {
      const file = join(dir, f);
      const parsed = CaseSchema.safeParse(parse(readFileSync(file, "utf8")));
      if (!parsed.success) throw new Error(`Invalid eval case ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      if (!parsed.data.pr && !parsed.data.fixture) throw new Error(`Eval case ${file} needs 'pr' or 'fixture'`);
      return { ...parsed.data, name: parsed.data.name ?? f.replace(/\.ya?ml$/, ""), file };
    });
}

/** Core cases (evals/cases, e.g. prompt injection) run for every project, then the project's own. */
export function loadCases(projectId: string): EvalCase[] {
  return [...readCases(join(paths.root, "evals", "cases")), ...readCases(join(paths.projectDir(projectId), "evals", "cases"))];
}

/** GitHub answering only for one made-up PR. */
function fixtureGitHub(repo: string, fixture: NonNullable<EvalCase["fixture"]>): GitHubClient {
  const p = { state: "closed", merged_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", html_url: `https://github.com/${repo}/pull/${fixture.pr.number}`, user: { login: "contributor" }, labels: [], additions: 1, deletions: 0, changed_files: fixture.files.length, base: { ref: "main" }, head: { ref: "fixture" }, ...fixture.pr } as unknown as PullRequest;
  const routes: Record<string, unknown> = { [`/repos/${repo}/pulls/${p.number}`]: p, [`/repos/${repo}/pulls/${p.number}/files`]: fixture.files as PullRequestFile[] };
  return {
    repo,
    async get<T>(path: string): Promise<T> {
      const key = path.split("?")[0];
      if (!(key in routes)) throw new GitHubError(`Not available in this eval fixture: ${path}`);
      return routes[key] as T;
    },
  };
}

/** The format the owner chose for this PR, if they ever did: labels collected from Telegram. */
function ownerLabel(projectId: string, pr: number): string | undefined {
  const row = sharedDb()
    .prepare("SELECT owner_answers FROM decisions WHERE project = ? AND subject = ? AND owner_answers IS NOT NULL ORDER BY decided_at DESC LIMIT 1")
    .get(projectId, `pr#${pr}`) as { owner_answers: string } | undefined;
  return row ? (JSON.parse(row.owner_answers).format as string | undefined) : undefined;
}

const contentOf = (o: Outcome) => (o.kind === "drafted" ? renderDraft(o.draft.draft) : "");

/** Copies the project's learned examples into the eval database, so evals measure the agent as it is now. */
function copyMemory(projectId: string, db: ReturnType<typeof openDb>): void {
  const rows = sharedDb().prepare("SELECT kind, format, text, score, uses, created_at FROM memory_items WHERE project = ? AND active = 1").all(projectId) as any[];
  for (const r of rows) {
    db.prepare("INSERT INTO memory_items (project, kind, format, text, score, uses, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(projectId, r.kind, r.format, r.text, r.score, r.uses, r.created_at, r.created_at);
  }
}

/**
 * Where briefs from earlier evals are kept. The key is what produces a brief: the analyst's harness
 * version and the brief step's code. Re-briefing the same PRs was half the cost of every eval.
 */
function briefCacheDir(project: ProjectConfig, harness: HarnessConfig): string {
  const code = ["src/pipeline/brief.ts", "src/sources/github/changes.ts"].map((f) => (existsSync(join(paths.root, f)) ? readFileSync(join(paths.root, f), "utf8") : "")).join("\n");
  const key = createHash("sha256").update(harnessVersions(project.id, harness).analyst + code).digest("hex").slice(0, 12);
  return join(paths.projectData(project.id), "evals", "briefs", key);
}

const caseKey = (c: EvalCase) => (c.fixture ? `${c.name}-${createHash("sha256").update(JSON.stringify(c.fixture)).digest("hex").slice(0, 8)}` : c.name);

async function runCase(c: EvalCase, project: ProjectConfig, harness: HarnessConfig, memory: boolean, briefs: { dir: string; fresh: boolean }): Promise<CaseResult> {
  const db = openDb(":memory:");
  if (memory) copyMemory(project.id, db);
  const gh = c.fixture ? fixtureGitHub(project.repo, c.fixture) : githubClient(project.repo);
  const deps: PipelineDeps = { project, harness, db, gh, repoTools: repoTools(gh, project.prefilter.ignorePaths) };
  const prNumber = c.fixture?.pr.number ?? c.pr!;
  const expectedFormat = c.expect.format ?? (c.fixture ? undefined : ownerLabel(project.id, prNumber));
  const base: CaseResult = { name: c.name, pr: prNumber, expectedFormat, formatSource: "failed", briefCached: false, checkIssues: [], mentionMissing: [], avoidFound: [], costUsd: 0 };
  const cost = () => (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs").get() as { c: number }).c;

  try {
    const { pr } = await getPullRequest(gh, prNumber);
    addEvent(db, { project: project.id, pr: prNumber, title: pr.title, url: pr.html_url, mergedAt: pr.merged_at ?? new Date().toISOString() });
    const cacheFile = join(briefs.dir, `${caseKey(c)}.json`);
    const cached = !briefs.fresh && existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, "utf8")) as { brief: unknown; version?: string }) : undefined;
    // A cached brief starts the event at the decision; patch notes for releases aren't rebuilt then.
    if (cached) updateEvent(db, `${project.id}:pr:${prNumber}`, { status: "briefed", brief: cached.brief, ...(cached.version ? { version: cached.version } : {}) });
    let outcome = await advance(getEventByPr(db, project.id, prNumber)!, deps);
    const briefed = getEventByPr(db, project.id, prNumber);
    if (!cached && briefed?.brief) {
      mkdirSync(briefs.dir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ brief: briefed.brief, version: briefed.version }, null, 2));
    }
    let formatSource: CaseResult["formatSource"] = "model";
    let format: string | undefined;
    if (outcome.kind === "ask_format") {
      formatSource = "unsure";
      // Still exercise the writer: continue with the expected format, or a single post.
      outcome = await applyFormat(outcome.event, (expectedFormat as any) ?? "post", deps, outcome.decision);
    } else if (outcome.kind === "skipped" && /prefilter|label|branch|only ignored|no user-facing/.test(outcome.reason)) {
      formatSource = "rule";
    }
    if (outcome.kind === "failed") return { ...base, briefCached: !!cached, error: outcome.reason, costUsd: cost() };
    format = outcome.kind === "drafted" ? outcome.draft.draft.format : outcome.kind === "held" ? "hold" : outcome.kind === "skipped" ? "skip" : undefined;

    const content = contentOf(outcome);
    const lower = content.toLowerCase();
    const drafted = outcome.kind === "drafted" ? outcome.draft : undefined;
    return {
      ...base,
      briefCached: !!cached,
      format,
      formatSource,
      formatCorrect: expectedFormat && formatSource !== "unsure" ? format === expectedFormat : undefined,
      checksPassed: drafted ? drafted.issues.length === 0 : undefined,
      checkIssues: drafted ? drafted.issues.map((i) => `${i.where}: ${i.message}`) : [],
      criticScore: drafted?.score,
      revisions: drafted?.revisions,
      mentionMissing: drafted ? c.expect.mention.filter((m) => !lower.includes(m.toLowerCase())) : [],
      avoidFound: c.expect.avoid.filter((a) => lower.includes(a.toLowerCase())),
      costUsd: cost(),
      content,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e), costUsd: cost() };
  }
}

const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : undefined);

export function summarize(cases: CaseResult[]): EvalReport["summary"] {
  const judged = cases.filter((c) => c.formatCorrect !== undefined);
  const checked = cases.filter((c) => c.checksPassed !== undefined);
  const withMentions = cases.filter((c) => c.content);
  return {
    formatAccuracy: judged.length ? mean(judged.map((c) => (c.formatCorrect ? 1 : 0))) : undefined,
    // Unsure answers go to the owner and don't count toward accuracy, so report how often that happens.
    unsureRate: cases.length ? mean(cases.map((c) => (c.formatSource === "unsure" ? 1 : 0))) : undefined,
    checkPassRate: checked.length ? mean(checked.map((c) => (c.checksPassed ? 1 : 0))) : undefined,
    meanCriticScore: mean(cases.flatMap((c) => (c.criticScore !== undefined ? [c.criticScore] : []))),
    mentionRate: withMentions.length ? mean(withMentions.map((c) => (c.mentionMissing.length === 0 ? 1 : 0))) : undefined,
    avoidViolations: cases.reduce((n, c) => n + c.avoidFound.length, 0),
    failures: cases.filter((c) => c.error).length,
    costUsd: Math.round(cases.reduce((n, c) => n + c.costUsd, 0) * 10000) / 10000,
  };
}

/** Current git commit and whether src/, prompts/, skills/, decisions/ or config/ have uncommitted changes. */
export function codeVersion(): EvalReport["code"] {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: paths.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { commit: git("rev-parse", "--short", "HEAD"), dirty: git("status", "--porcelain", "--", "src", "prompts", "skills", "decisions", "config") !== "" };
  } catch {
    return undefined;
  }
}

/** `--model writer=openrouter:x/y` overrides, applied on top of the project's harness config. */
export function withOverrides(harness: HarnessConfig, overrides: Record<string, string>): HarnessConfig {
  const patch: Record<string, unknown> = { roles: {} };
  for (const [role, model] of Object.entries(overrides)) {
    if (role === "decisions") patch.decisions = { model };
    else (patch.roles as Record<string, unknown>)[role] = { model };
  }
  return HarnessConfigSchema.parse(deepMerge(harness, patch));
}

/** Runs every case, saves the report and returns it with the previous report for comparison. */
export async function runEvals(
  project: ProjectConfig,
  harness: HarnessConfig,
  onCase?: (r: CaseResult) => void,
  opts: { memory?: boolean; freshBriefs?: boolean } = {},
): Promise<{ report: EvalReport; previous?: EvalReport; file: string }> {
  const memory = opts.memory ?? true;
  const briefs = { dir: briefCacheDir(project, harness), fresh: opts.freshBriefs ?? false };
  const cases = loadCases(project.id);
  if (cases.length === 0) throw new Error(`No eval cases. Add YAML files to projects/${project.id}/evals/cases/ (e.g. 'pr: 16').`);
  const results: CaseResult[] = [];
  for (const c of cases) {
    const r = await runCase(c, project, harness, memory, briefs);
    results.push(r);
    onCase?.(r);
  }
  const dir = join(paths.projectData(project.id), "evals");
  mkdirSync(dir, { recursive: true });
  const previousFile = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().pop();
  const previous = previousFile ? (JSON.parse(readFileSync(join(dir, previousFile), "utf8")) as EvalReport) : undefined;
  const report: EvalReport = {
    project: project.id,
    at: new Date().toISOString(),
    harness: harnessVersions(project.id, harness),
    code: codeVersion(),
    models: Object.fromEntries(Object.entries(harness.roles).map(([r, rc]) => [r, rc.model])),
    decisionModel: harness.decisions.model,
    memory,
    cases: results,
    summary: summarize(results),
  };
  const file = join(dir, `${report.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return { report, previous, file };
}
