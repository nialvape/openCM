import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { runChecks, POSTS_PER_FORMAT, type CheckIssue } from "../checks/checks.js";
import { measure, measurePostsTool, X_LIMIT } from "../tools/measure.js";
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
  /** Corrections applied in earlier rounds, which a rewrite for new problems must not undo. */
  applied?: string[];
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
        : // A link reply costs about 13 posts, so it's only offered when the decision said it's worth it;
          // drafts the decision model didn't see (the owner's format, combined PRs, digests) get none.
          o.wantsLink === true
          ? "Don't put links or domain names in the posts. Put the link readers need in linkReply (a reply under the last post): a specific page, never just the repo or the project's homepage."
          : "Don't include any link or domain name; leave linkReply out.";
  return [
    `Write a ${o.format} for X about the changes in the briefs below (${min === max ? `${min} post` : `${min} to ${max} posts`}). Load the ${SKILL_FOR[o.format]} skill first.`,
    `Language: ${deps.project.language}. Each post at most ${X_LIMIT} characters. Before answering, measure your posts with measure_posts and shorten any that are over. ${links}`,
    'Each post lists in "claims" the changes it states, as "<pr>:<change id>" (e.g. "16:c1"). Only state what the briefs support.',
    o.extra ?? "",
    o.previous ? `Previous version:\n${JSON.stringify(o.previous, null, 2)}` : "",
    o.instruction ? `The maintainer asked for this change: ${o.instruction}\nIt wins over any other correction below that contradicts it.` : "",
    issues.length ? `Fix these problems:\n${issues.map((i) => `- ${i}`).join("\n")}` : "",
    o.applied?.length ? `The previous version already applies these earlier corrections. Keep them all:\n${o.applied.map((i) => `- ${i}`).join("\n")}` : "",
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
    tools: { measure_posts: measurePostsTool() },
    harness: deps.harness,
    db: deps.db,
    model: deps.models?.writer,
  });
  // The prompt says no link reply unless one is wanted; the code makes sure, since each one costs money.
  const { linkReply, ...rest } = value;
  return { ...rest, format: o.format, ...(o.wantsLink === true && linkReply ? { linkReply } : {}) };
}

const formatSize = (format: Draft["format"]) => {
  const [min, max] = POSTS_PER_FORMAT[format];
  return min === max ? `exactly ${min} post${min === 1 ? "" : "s"}` : `${min} to ${max} posts`;
};

async function critique(draft: Draft, briefs: ChangeBrief[], deps: PipelineDeps, ownerInstruction?: string): Promise<Critique> {
  const { value } = await runAgentJson(CritiqueSchema, {
    role: "critic",
    projectId: deps.project.id,
    task: [
      `Review this ${draft.format} draft against the change briefs.`,
      // Without the shape the critic asked to split a single post in two, which the checks then reject.
      `The format is fixed: a ${draft.format} has ${formatSize(draft.format)}. Never suggest adding or splitting posts; if something doesn't fit, say what to drop.`,
      // Without this the critic undid the owner's own request (plural address, no "NO OFICIAL") as off-voice.
      ownerInstruction
        ? `The maintainer asked for this version: "${ownerInstruction}". That's their decision, above the voice and the glossary: never ask to undo it.`
        : "",
      `Draft:\n${JSON.stringify(draft, null, 2)}`,
      // The critic can't count either; without this it asked to add text to posts that were full.
      `Length of each post as X counts it (limit ${X_LIMIT}):\n${measure(draft.posts.map((p) => p.text)).map((m) => `post ${m.post}: ${m.length}/${X_LIMIT}`).join("\n")}`,
      asUntrustedData("change briefs", JSON.stringify(briefs, null, 2)),
    ]
      .filter(Boolean)
      .join("\n\n"),
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

/** Problems confined to one post's text, which can be fixed without touching the rest of the draft. */
const LOCAL_CHECKS = new Set<CheckIssue["check"]>(["length", "link_policy", "banned_term", "secret"]);
// A link reply in a project that doesn't use one is a structural problem: rewriting its text won't fix it.
const isLocal = (i: CheckIssue) => LOCAL_CHECKS.has(i.check) && (/^post \d+$/.test(i.where) || (i.where === "link reply" && i.check !== "link_policy"));
/** Rounds of local repair per draft; each round is one short call per failing post. */
const REPAIR_ROUNDS = 2;
const VARIANTS = 3;

const VariantsSchema = z.object({ variants: z.array(z.string().min(1)).min(1).max(VARIANTS) });

function withText(draft: Draft, where: string, text: string): Draft {
  if (where === "link reply") return { ...draft, linkReply: text };
  const index = Number(where.slice("post ".length)) - 1;
  return { ...draft, posts: draft.posts.map((p, i) => (i === index ? { ...p, text } : p)) };
}

const textAt = (draft: Draft, where: string) => (where === "link reply" ? (draft.linkReply ?? "") : draft.posts[Number(where.slice("post ".length)) - 1].text);

/** Asks for a few rewrites of one post and keeps the first that passes the checks for that post. */
async function repairOne(draft: Draft, where: string, problems: CheckIssue[], o: WriteOptions, deps: PipelineDeps, keep: string[]): Promise<Draft> {
  const { value } = await runAgentJson(VariantsSchema, {
    role: "writer",
    projectId: deps.project.id,
    task: [
      `This ${where} of a ${draft.format} for X needs fixing:`,
      problems.map((p) => `- ${p.message}`).join("\n"),
      `Current text:\n${textAt(draft, where)}`,
      // Without these, shortening undid the corrections the rewrite had just applied.
      keep.length ? `This text applies these corrections. Every version must still respect all of them:\n${keep.map((k) => `- ${k}`).join("\n")}` : "",
      `Write ${VARIANTS} alternative versions that fix it, keeping the meaning, the facts and the language (${deps.project.language}). Each at most ${X_LIMIT} characters; measure them with measure_posts before answering.`,
      'Answer with only JSON: {"variants": ["...", "..."]}',
      asUntrustedData("change briefs", JSON.stringify(o.briefs, null, 2)),
    ].join("\n\n"),
    tools: { measure_posts: measurePostsTool() },
    harness: deps.harness,
    db: deps.db,
    model: deps.models?.writer,
  });
  const candidates = value.variants.map((v) => {
    const next = withText(draft, where, v);
    return { next, left: runChecks(next, o.briefs, deps.project).filter((i) => i.where === where).length };
  });
  // Variants that still fail aren't worse than the original; the next round or a rewrite tries again.
  return candidates.find((c) => c.left === 0)?.next ?? candidates.sort((a, b) => a.left - b.left)[0].next;
}

/**
 * Fixes problems local to single posts (too long, a link, a banned term) with one short call per
 * failing post, before falling back to rewriting the whole draft. Returns the draft and its checks.
 */
async function repairLocal(draft: Draft, o: WriteOptions, deps: PipelineDeps, keep: string[] = []): Promise<{ draft: Draft; issues: CheckIssue[] }> {
  let issues = runChecks(draft, o.briefs, deps.project);
  for (let round = 0; round < REPAIR_ROUNDS && issues.length > 0 && issues.every(isLocal); round++) {
    for (const where of [...new Set(issues.map((i) => i.where))]) {
      draft = await repairOne(draft, where, issues.filter((i) => i.where === where), o, deps, keep);
    }
    issues = runChecks(draft, o.briefs, deps.project);
  }
  return { draft, issues };
}

/**
 * Writer → deterministic checks → critic, with at most `maxRevisions` rewrites. Checks failing
 * after the last rewrite are kept on the draft so the owner sees them; the owner always decides.
 */
export async function composeDraft(input: WriteOptions, deps: PipelineDeps, maxRevisions = 2): Promise<ComposedDraft> {
  // Without briefs the writer has no facts and the claims check nothing to verify against.
  if (input.briefs.length === 0) throw new Error("This draft has no PRs attached, so there's nothing to write from. Ask for it again with /pr <number>.");
  const examples = input.memory === false ? [] : selectExamples(deps.db, deps.project.id, input.format, deps.harness.memory.examplesPerDraft);
  const o: WriteOptions = { ...input, extra: [input.extra, examplesBlock(examples)].filter(Boolean).join("\n\n") || undefined };
  // The owner's request, when there is one, must survive every shortening too.
  const owner = o.instruction ? [`The maintainer's request: ${o.instruction}`] : [];
  let { draft, issues } = await repairLocal(await write(o, deps, []), o, deps, owner);
  let revisions = 0;
  let review: Critique | undefined;
  const applied: string[] = [];
  // The latest version that passed every check, with its review: a last rewrite that breaks a check
  // (e.g. a post turned into two) must not replace it.
  let passing: { draft: Draft; review: Critique } | undefined;

  while (true) {
    if (issues.length === 0) {
      review = await critique(draft, o.briefs, deps, o.instruction);
      passing = { draft, review };
      if (!needsRevision(review) || revisions >= maxRevisions) break;
    } else if (revisions >= maxRevisions) {
      if (passing) ({ draft, review } = passing), (issues = []);
      break;
    }
    const feedback = issues.length ? formatIssues(issues) : review!.fixes.length ? review!.fixes : ["The reviewer asked for a better version."];
    // Earlier rounds' corrections ride along: without them a rewrite for new problems undid old fixes.
    ({ draft, issues } = await repairLocal(await write({ ...o, previous: draft, applied }, deps, feedback), o, deps, [...owner, ...applied, ...feedback]));
    applied.push(...feedback);
    review = undefined;
    revisions++;
  }

  const id = randomUUID();
  saveDraft(deps.db, deps.project.id, id, o.briefs.map((b) => b.pr), draft, issues, review, revisions);
  supersedeOlderDrafts(deps.db, deps.project.id, id, o.briefs.map((b) => b.pr));
  recordUsage(deps.db, id, examples);
  return { id, draft, issues, critique: review, score: review ? weightedScore(review) : undefined, revisions };
}

/**
 * One live draft per PR: a new draft about a PR replaces any pending one about it. Otherwise the
 * old card stayed actionable, and editing it rewrote a draft whose PRs had moved on.
 */
function supersedeOlderDrafts(db: DatabaseSync, project: string, id: string, prs: number[]): void {
  db.prepare(
    `UPDATE drafts SET status = 'superseded', owner_note = COALESCE(owner_note, ?), updated_at = ?
     WHERE project = ? AND status = 'pending' AND id != ? AND EXISTS (SELECT 1 FROM json_each(drafts.prs) WHERE value IN (${prs.map(() => "?").join(", ")}))`,
  ).run(`replaced by draft ${id}`, now(), project, id, ...prs);
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
