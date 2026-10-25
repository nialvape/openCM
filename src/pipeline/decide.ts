import type { Experimental_DecisionModel } from "ai";
import { loadSections } from "../core/context.js";
import { decideGated, loadDecisionSchema } from "../core/decision.js";
import { asUntrustedData } from "../core/policy.js";
import { elideFiles, getPullRequest } from "../sources/github/changes.js";
import type { PullRequestFile } from "../sources/github/client.js";
import { eventsWithStatus, type ChangeEvent } from "../store/events.js";
import type { ChangeBrief } from "./brief.js";
import type { PipelineDeps } from "./types.js";

export type Format = "skip" | "hold" | "post" | "thread";
export const FORMATS: Format[] = ["skip", "hold", "post", "thread"];

export interface FormatDecision {
  /** Undefined when the owner has to choose. */
  format?: Format;
  decisionId?: string;
  probabilities?: Record<string, number>;
  mergeWithHeld: boolean;
  wantsLink: boolean;
  reason: string;
}

/** Posts and threads approved or published today, for the daily cap. */
export function postsToday(deps: PipelineDeps): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = deps.db
    .prepare("SELECT COUNT(*) AS n FROM drafts WHERE project = ? AND status IN ('approved', 'published') AND format IN ('post', 'thread') AND updated_at >= ?")
    .get(deps.project.id, today) as { n: number };
  return row.n;
}

/**
 * Hard rules applied after the model's answer: the daily cap holds posts for the digest. A release
 * alone doesn't force a thread; it always gets patch notes, and the post format is judged like any PR.
 */
export function applyGuards(format: Format, event: ChangeEvent, deps: PipelineDeps): { format: Format; reason?: string } {
  if ((format === "post" || format === "thread") && postsToday(deps) >= deps.project.posting.maxPostsPerDay) {
    return { format: "hold", reason: `daily cap of ${deps.project.posting.maxPostsPerDay} posts reached` };
  }
  return { format };
}

export type BumpLevel = "major" | "minor" | "patch" | "other";

/** Which semver part changed: the maintainer's own estimate of how big a release is. */
export function bumpLevel(from: string, to: string): BumpLevel {
  const parts = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const [a, b] = [parts(from), parts(to)];
  if (!a || !b) return "other";
  if (a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  return a[2] !== b[2] ? "patch" : "other";
}

/** The version a release PR replaced, from the removed line of its version file. */
function previousVersion(files: PullRequestFile[], deps: PipelineDeps): string | undefined {
  for (const vf of deps.project.versionFiles) {
    const pattern = new RegExp(vf.pattern);
    const removed = files
      .find((f) => f.filename === vf.path)
      ?.patch?.split("\n")
      .filter((l) => l.startsWith("-"))
      .map((l) => pattern.exec(l.slice(1))?.[1])
      .find(Boolean);
    if (removed) return removed;
  }
  return undefined;
}

export interface Precedent {
  pr: string | null;
  change?: string;
  bump?: BumpLevel;
  model_chose?: string;
  owner_chose: string;
  outcome: "accepted" | "changed" | "owner only";
}

/**
 * The owner's latest format choices, with what each change was and what the model had said: the
 * model learns the owner's taste from them. The PR being decided is left out.
 */
export function ownerPrecedents(deps: PipelineDeps, excludeSubject: string): Precedent[] {
  if (deps.harness.decisions.historySize === 0) return [];
  const rows = deps.db
    .prepare(
      "SELECT subject, state, answers, owner_answers FROM decisions WHERE project = ? AND schema = 'content-format' AND owner_answers IS NOT NULL AND (subject IS NULL OR subject != ?) ORDER BY decided_at DESC LIMIT ?",
    )
    .all(deps.project.id, excludeSubject, deps.harness.decisions.historySize) as { subject: string | null; state: string; answers: string; owner_answers: string }[];
  return rows.flatMap((r) => {
    const owner = JSON.parse(r.owner_answers).format as string | undefined;
    if (!owner) return [];
    const state = JSON.parse(r.state);
    const model = JSON.parse(r.answers).format?.value as string | undefined;
    const bump = state.pull_request?.release?.bump;
    // Absent fields are left out, not undefined: the state must be valid JSON.
    return [{
      pr: r.subject,
      ...(state.change_brief?.summary ? { change: state.change_brief.summary } : {}),
      ...(bump ? { bump } : {}),
      ...(model ? { model_chose: model } : {}),
      owner_chose: owner,
      outcome: !model ? "owner only" : model === owner ? "accepted" : "changed",
    } satisfies Precedent];
  });
}

/** Total diff characters given to the decision model; its context is large, but past this it's noise. */
const MAX_DIFF_CHARS = 40_000;

/**
 * What the decision model can't get from the brief: labels, the description, the diff itself and how
 * big a release the maintainer called it. Without GitHub it decides on the brief.
 */
async function pullRequestFacts(number: number, version: string | undefined, deps: PipelineDeps): Promise<Record<string, unknown>> {
  try {
    const { pr, files } = await getPullRequest(deps.gh, number);
    const previous = version ? previousVersion(files, deps) : undefined;
    let budget = MAX_DIFF_CHARS;
    const diff = elideFiles(files, deps.project.prefilter.ignorePaths).map((f) => {
      const head = `--- ${f.status} ${f.file} (+${f.additions} −${f.deletions})${f.elided ? ` [${f.elided}]` : ""}`;
      const patch = f.patch && budget > 0 ? f.patch.slice(0, budget) : undefined;
      budget -= patch?.length ?? 0;
      return patch ? `${head}\n${patch}${patch.length < f.patch!.length ? "\n[cut: diff budget used up]" : ""}` : head;
    });
    return {
      ...(version ? { release: { version, previous: previous ?? null, bump: previous ? bumpLevel(previous, version) : null } } : {}),
      labels: pr.labels.map((l) => l.name),
      size: { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) },
      description: asUntrustedData(`PR #${number} description`, pr.body ?? "(no description)"),
      diff: asUntrustedData(`PR #${number} diff`, diff.join("\n")),
    };
  } catch {
    return {};
  }
}

/**
 * Picks how much content a briefed change deserves. Changes with nothing user-facing are skipped
 * without a model call; the decision model answers the rest, and its unsure answers go to the owner.
 */
export async function decideFormat(event: ChangeEvent, brief: ChangeBrief, deps: PipelineDeps, model?: Experimental_DecisionModel): Promise<FormatDecision> {
  if (!brief.userFacing && !event.version) return { format: "skip", mergeWithHeld: false, wantsLink: false, reason: "no user-facing change in the brief" };

  const held = eventsWithStatus(deps.db, deps.project.id, "held");
  const state = {
    audience: loadSections("decision", deps.project.id).audience ?? "(not described: assume the project's end users)",
    change_brief: brief,
    pull_request: { number: event.pr, title: event.title, release: event.version ? { version: event.version } : null, ...(await pullRequestFacts(event.pr, event.version, deps)) },
    owner_precedents: ownerPrecedents(deps, `pr#${event.pr}`),
    held_for_digest: held.map((e) => ({ pr: e.pr, summary: (e.brief as ChangeBrief | undefined)?.summary })),
    posts_published_today: postsToday(deps),
    max_posts_per_day: deps.project.posting.maxPostsPerDay,
  };

  let decision;
  try {
    decision = await decideGated({
      schema: loadDecisionSchema("content-format", deps.project.id),
      state,
      config: deps.harness.decisions,
      projectId: deps.project.id,
      subject: `pr#${event.pr}`,
      db: deps.db,
      model,
    });
  } catch (e) {
    // Without a decision model the owner decides; the pipeline must not stop.
    return { mergeWithHeld: false, wantsLink: false, reason: `decision model failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const fmt = decision.answers.format;
  const merge = decision.answers.merge_with_held;
  const link = decision.answers.link_worth_cost;
  const base = {
    decisionId: decision.id,
    probabilities: fmt?.type === "choice" ? fmt.probabilities : undefined,
    mergeWithHeld: merge?.type === "boolean" && !decision.needsOwner.includes("merge_with_held") ? merge.value : false,
    wantsLink: link?.type === "boolean" && !decision.needsOwner.includes("link_worth_cost") ? link.value : false,
  };
  if (decision.needsOwner.includes("format") || fmt?.type !== "choice") return { ...base, reason: "not confident enough about the format" };
  const guarded = applyGuards(fmt.value as Format, event, deps);
  return { ...base, format: guarded.format, reason: guarded.reason ?? `decision model (${Math.round((fmt.confidence ?? 0) * 100)}%)` };
}
