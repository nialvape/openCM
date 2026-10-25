import type { Experimental_DecisionModel } from "ai";
import { loadSections } from "../core/context.js";
import { decideGated, loadDecisionSchema } from "../core/decision.js";
import { asUntrustedData } from "../core/policy.js";
import { elideFiles, getPullRequest } from "../sources/github/changes.js";
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

/** Total diff characters given to the decision model; its context is large, but past this it's noise. */
const MAX_DIFF_CHARS = 40_000;

/**
 * What the decision model can't get from the brief: labels, the description and the diff itself, so
 * it judges the change and not only the analyst's account of it. Without GitHub it decides on the brief.
 */
async function pullRequestFacts(number: number, deps: PipelineDeps): Promise<Record<string, unknown>> {
  try {
    const { pr, files } = await getPullRequest(deps.gh, number);
    let budget = MAX_DIFF_CHARS;
    const diff = elideFiles(files, deps.project.prefilter.ignorePaths).map((f) => {
      const head = `--- ${f.status} ${f.file} (+${f.additions} −${f.deletions})${f.elided ? ` [${f.elided}]` : ""}`;
      const patch = f.patch && budget > 0 ? f.patch.slice(0, budget) : undefined;
      budget -= patch?.length ?? 0;
      return patch ? `${head}\n${patch}${patch.length < f.patch!.length ? "\n[cut: diff budget used up]" : ""}` : head;
    });
    return {
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
    pull_request: { number: event.pr, title: event.title, release: event.version ?? null, ...(await pullRequestFacts(event.pr, deps)) },
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
