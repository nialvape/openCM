import picomatch from "picomatch";
import type { ProjectConfig } from "../../core/config.js";
import type { GitHubClient, PullRequest, PullRequestFile } from "./client.js";

/** Files that never explain a change to users, whatever the project. */
const ALWAYS_ELIDED = ["**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/*.lock", "**/*.min.*", "**/dist/**", "**/build/**", "**/vendor/**", "**/*.snap", "**/*.svg"];

/** Longest patch kept per file, in characters; bigger patches are summarized as line counts. */
const MAX_FILE_PATCH = 6000;

export interface ElidedFile {
  file: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  /** Why the patch isn't shown, when it isn't. */
  elided?: string;
}

const matcher = (globs: string[]) => (globs.length ? picomatch(globs, { dot: true }) : () => false);

/**
 * Rule-based trimming before any model sees the diff: lockfiles, generated and ignored files keep
 * only their line counts, and huge patches are cut. Cheaper and as good as summarizing with a model.
 */
export function elideFiles(files: PullRequestFile[], ignorePaths: string[]): ElidedFile[] {
  const always = matcher(ALWAYS_ELIDED);
  const ignored = matcher(ignorePaths);
  return files.map((f) => {
    const base = { file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions };
    if (always(f.filename)) return { ...base, elided: "generated or lockfile" };
    if (ignored(f.filename)) return { ...base, elided: "ignored by project prefilter" };
    if (!f.patch) return { ...base, elided: "no text diff (binary or too large for GitHub)" };
    if (f.patch.length > MAX_FILE_PATCH) return { ...base, patch: f.patch.slice(0, MAX_FILE_PATCH), elided: `patch cut at ${MAX_FILE_PATCH} characters` };
    return { ...base, patch: f.patch };
  });
}

export interface PrefilterResult {
  skip: boolean;
  reason?: string;
}

/** Decides without any model whether a PR can't deserve content: wrong branch, ignored label, or only ignored files. */
export function prefilter(pr: PullRequest, files: PullRequestFile[], project: ProjectConfig): PrefilterResult {
  if (pr.base.ref !== project.branch) return { skip: true, reason: `merged into ${pr.base.ref}, not ${project.branch}` };
  const label = pr.labels.find((l) => project.prefilter.ignoreLabels.includes(l.name));
  if (label) return { skip: true, reason: `label '${label.name}'` };
  const relevant = elideFiles(files, project.prefilter.ignorePaths).filter((f) => f.elided !== "generated or lockfile" && f.elided !== "ignored by project prefilter");
  if (files.length > 0 && relevant.length === 0) return { skip: true, reason: "only ignored, generated or lock files changed" };
  return { skip: false };
}

/** New version when a PR changes a version line in one of the project's version files. */
export function detectVersionBump(files: PullRequestFile[], project: ProjectConfig): string | undefined {
  for (const vf of project.versionFiles) {
    const file = files.find((f) => f.filename === vf.path);
    if (!file?.patch) continue;
    const pattern = new RegExp(vf.pattern);
    let before: string | undefined;
    let after: string | undefined;
    for (const line of file.patch.split("\n")) {
      const m = pattern.exec(line.slice(1));
      if (!m) continue;
      if (line.startsWith("-")) before = m[1];
      else if (line.startsWith("+")) after = m[1];
    }
    if (after && after !== before) return after;
  }
  return undefined;
}

export async function getPullRequest(gh: GitHubClient, number: number): Promise<{ pr: PullRequest; files: PullRequestFile[] }> {
  const [pr, files] = await Promise.all([
    gh.get<PullRequest>(`/repos/${gh.repo}/pulls/${number}`),
    gh.get<PullRequestFile[]>(`/repos/${gh.repo}/pulls/${number}/files?per_page=100`),
  ]);
  return { pr, files };
}

/** PRs merged after `afterIso`, oldest first. Scans recently updated closed PRs, which covers every new merge. */
export async function mergedPullsSince(gh: GitHubClient, afterIso: string): Promise<PullRequest[]> {
  const out: PullRequest[] = [];
  for (let page = 1; page <= 5; page++) {
    const prs = await gh.get<PullRequest[]>(`/repos/${gh.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50&page=${page}`);
    out.push(...prs.filter((p) => p.merged_at && p.merged_at > afterIso));
    // Sorted by last update: once a whole page is older than the cursor, nothing newer is left.
    const lastUpdate = prs[prs.length - 1]?.updated_at;
    if (prs.length < 50 || (lastUpdate && lastUpdate <= afterIso)) break;
  }
  return out.sort((a, b) => a.merged_at!.localeCompare(b.merged_at!));
}
