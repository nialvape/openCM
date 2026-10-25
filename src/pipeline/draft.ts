import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { runChecks, POSTS_PER_FORMAT, type CheckIssue } from "../checks/checks.js";
import { asUntrustedData } from "../core/policy.js";
import { runAgentJson } from "../core/structured.js";
import { now } from "../store/db.js";
import { examplesBlock, recordUsage, selectExamples } from "./memory.js";
import type { ChangeBrief } from "./brief.js";
import type { PipelineDeps } from "./types.js";

export const DraftSchema = z.object({
  format: z.enum(["post", "thread", "digest"]),
  posts: z.array(z.object({ text: z.string().min(1), claims: z.array(z.string()) })).min(1),
  linkReply: z.string().optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

export const CritiqueSchema = z.object({
  scores: z.object({
    accuracy: z.number().min(1).max(5),
    clarity: z.number().min(1).max(5),
    hook: z.number().min(1).max(5),
    voice: z.number().min(1).max(5),
    value: z.number().min(1).max(5),
    noHype: z.number().min(1).max(5),
  }),
  verdict: z.enum(["ok", "revise"]),
  fixes: z.array(z.string()).default([]),
});
export type Critique = z.infer<typeof CritiqueSchema>;

/** Weights of the critic's rubric: accuracy matters most, it's where writers fail quietly. */
const WEIGHTS: Record<keyof Critique["scores"], number> = { accuracy: 3, clarity: 1.5, value: 1.5, voice: 1, hook: 1, noHype: 1 };

export function weightedScore(c: Critique): number {
  let sum = 0;
  let total = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    sum += c.scores[k as keyof Critique["scores"]] * w;
    total += w;
  }
  return Math.round((sum / total) * 100) / 100;
}

/** The critic advises: it can send a draft back, never approve it for publishing. */
export function needsRevision(c: Critique): boolean {
  return c.verdict === "revise" || c.scores.accuracy < 4 || Object.values(c.scores).some((s) => s <= 2);
}

export interface WriteOptions {
  format: Draft["format"];
  briefs: ChangeBrief[];
  /** From the decision model: whether readers need a link enough to pay for it. */
  wantsLink?: boolean;
  /** Owner instruction for a rewrite, e.g. "más corto". */
  instruction?: string;
  /** The previous version when revising. */
  previous?: Draft;
  /** Extra context for the writer (it goes in the task, so the cached system prompt stays the same). */
  extra?: string;
  /** Show the writer approved examples from memory (default true; evals turn it off for a baseline). */
  memory?: boolean;
}

const SKILL_FOR: Record<Draft["format"], string> = { post: "x-post", thread: "x-thread", digest: "x-digest" };

function writeTask(o: WriteOptions, deps: PipelineDeps, issues: string[]): string {
  const linkPolicy = deps.project.channels.x?.linkPolicy ?? "reply";
  const [min, max] = POSTS_PER_FORMAT[o.format];
  const links =
    linkPolicy === "none"
      ? "Don't include any link or domain name."
      : linkPolicy === "inline"
        ? "A link may go in the last post if readers need it."
        : o.wantsLink === false
          ? "Don't include any link or domain name; leave linkReply out."
          : "Don't put links or domain names in the posts. If readers need one, put it in linkReply (a reply under the last post).";
  return [
    `Write a ${o.format} for X about the changes in the briefs below (${min === max ? `${min} post` : `${min} to ${max} posts`}). Load the ${SKILL_FOR[o.format]} skill first.`,
    `Language: ${deps.project.language}. Each post at most 280 characters. ${links}`,
    'Each post lists in "claims" the changes it states, as "<pr>:<change id>" (e.g. "16:c1"). Only state what the briefs support.',
    o.extra ?? "",
    o.previous ? `Previous version:\n${JSON.stringify(o.previous, null, 2)}` : "",
    o.instruction ? `The maintainer asked for this change: ${o.instruction}` : "",
    issues.length ? `Fix these problems:\n${issues.map((i) => `- ${i}`).join("\n")}` : "",
    'Answer with only JSON: {"format": "...", "posts": [{"text": "...", "claims": ["..."]}], "linkReply": "optional"}',
    asUntrustedData("change briefs", JSON.stringify(o.briefs, null, 2)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the writer must return. The format is the pipeline's choice, so the model's label is ignored. */
const WriterOutputSchema = DraftSchema.extend({ format: z.string().optional() });

async function write(o: WriteOptions, deps: PipelineDeps, issues: string[]): Promise<Draft> {
  const { value } = await runAgentJson(WriterOutputSchema, {
    role: "writer",
    projectId: deps.project.id,
    task: writeTask(o, deps, issues),
    harness: deps.harness,
    db: deps.db,
    model: deps.models?.writer,
  });
  return { ...value, format: o.format };
}

async function critique(draft: Draft, briefs: ChangeBrief[], deps: PipelineDeps): Promise<Critique> {
  const { value } = await runAgentJson(CritiqueSchema, {
    role: "critic",
    projectId: deps.project.id,
    task: [
      `Review this ${draft.format} draft against the change briefs.`,
      `Draft:\n${JSON.stringify(draft, null, 2)}`,
      asUntrustedData("change briefs", JSON.stringify(briefs, null, 2)),
    ].join("\n\n"),
    harness: deps.harness,
    db: deps.db,
    model: deps.models?.critic,
  });
  return value;
}

export interface ComposedDraft {
  id: string;
  draft: Draft;
  issues: CheckIssue[];
  critique?: Critique;
  score?: number;
  revisions: number;
}

const formatIssues = (issues: CheckIssue[]) => issues.map((i) => `${i.where}: ${i.message}`);

/**
 * Writer → deterministic checks → critic, with at most `maxRevisions` rewrites. Checks failing
 * after the last rewrite are kept on the draft so the owner sees them; the owner always decides.
 */
export async function composeDraft(input: WriteOptions, deps: PipelineDeps, maxRevisions = 2): Promise<ComposedDraft> {
  const examples = input.memory === false ? [] : selectExamples(deps.db, deps.project.id, input.format, deps.harness.memory.examplesPerDraft);
  const o: WriteOptions = { ...input, extra: [input.extra, examplesBlock(examples)].filter(Boolean).join("\n\n") || undefined };
  let draft = await write(o, deps, []);
  let issues = runChecks(draft, o.briefs, deps.project);
  let revisions = 0;
  let review: Critique | undefined;

  while (true) {
    if (issues.length === 0) {
      review = await critique(draft, o.briefs, deps);
      if (!needsRevision(review) || revisions >= maxRevisions) break;
    } else if (revisions >= maxRevisions) {
      break;
    }
    const feedback = issues.length ? formatIssues(issues) : review!.fixes.length ? review!.fixes : ["The reviewer asked for a better version."];
    draft = await write({ ...o, previous: draft }, deps, feedback);
    issues = runChecks(draft, o.briefs, deps.project);
    review = undefined;
    revisions++;
  }

  const id = randomUUID();
  saveDraft(deps.db, deps.project.id, id, o.briefs.map((b) => b.pr), draft, issues, review, revisions);
  recordUsage(deps.db, id, examples);
  return { id, draft, issues, critique: review, score: review ? weightedScore(review) : undefined, revisions };
}

function saveDraft(db: DatabaseSync, project: string, id: string, prs: number[], draft: Draft, issues: CheckIssue[], review: Critique | undefined, revisions: number): void {
  db.prepare(
    "INSERT INTO drafts (id, project, prs, format, content, checks, critique, revisions, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
  ).run(id, project, JSON.stringify(prs), draft.format, JSON.stringify(draft), JSON.stringify(issues), review ? JSON.stringify(review) : null, revisions, now(), now());
}

export function renderDraft(d: Draft): string {
  const posts = d.posts.map((p, i) => (d.posts.length > 1 ? `${i + 1}/${d.posts.length}\n${p.text}` : p.text));
  return [...posts, ...(d.linkReply ? [`↳ reply: ${d.linkReply}`] : [])].join("\n\n");
}
