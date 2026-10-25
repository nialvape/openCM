import { recordOwnerAnswers } from "../core/decision.js";
import { runChecks } from "../checks/checks.js";
import { now } from "../store/db.js";
import { eventsForDraft, getEvent, updateEvent, type ChangeEvent } from "../store/events.js";
import type { ChangeBrief } from "./brief.js";
import { composeDraft, DraftSchema, type ComposedDraft, type Critique, type Draft } from "./draft.js";
import { applyFormat, draftFor, type Outcome } from "./flow.js";
import type { Format } from "./decide.js";
import type { PipelineDeps } from "./types.js";

export type DraftStatus = "pending" | "approved" | "rejected" | "superseded" | "published";

export interface StoredDraft extends ComposedDraft {
  status: DraftStatus;
  prs: number[];
  final?: Draft;
  ownerNote?: string;
}

export function getDraft(deps: PipelineDeps, id: string): StoredDraft | undefined {
  const r = deps.db.prepare("SELECT * FROM drafts WHERE id = ? AND project = ?").get(id, deps.project.id) as any;
  if (!r) return undefined;
  const critique = r.critique ? (JSON.parse(r.critique) as Critique) : undefined;
  return {
    id: r.id,
    draft: JSON.parse(r.content),
    issues: JSON.parse(r.checks),
    critique,
    revisions: r.revisions,
    status: r.status,
    prs: JSON.parse(r.prs),
    final: r.final ? JSON.parse(r.final) : undefined,
    ownerNote: r.owner_note ?? undefined,
  };
}

export function pendingDrafts(deps: PipelineDeps): StoredDraft[] {
  const ids = deps.db.prepare("SELECT id FROM drafts WHERE project = ? AND status = 'pending' ORDER BY created_at").all(deps.project.id) as { id: string }[];
  return ids.map((r) => getDraft(deps, r.id)!);
}

function setDraftStatus(deps: PipelineDeps, id: string, status: DraftStatus, extra: { final?: Draft; note?: string } = {}): void {
  deps.db
    .prepare("UPDATE drafts SET status = ?, final = COALESCE(?, final), owner_note = COALESCE(?, owner_note), updated_at = ? WHERE id = ?")
    .run(status, extra.final ? JSON.stringify(extra.final) : null, extra.note ?? null, now(), id);
}

function requirePending(deps: PipelineDeps, id: string): StoredDraft {
  const d = getDraft(deps, id);
  if (!d) throw new Error(`Draft ${id} not found`);
  if (d.status !== "pending") throw new Error(`That draft is already ${d.status}`);
  return d;
}

/** The owner's format choice is a label for the decision model's question about that PR. */
function labelFormat(deps: PipelineDeps, events: ChangeEvent[], format: Format): void {
  for (const e of events) if (e.decisionId) recordOwnerAnswers(e.decisionId, { format }, deps.db);
}

const formatLabel = (d: Draft): Format => (d.format === "digest" ? "hold" : d.format);

/** Approves a draft as it is (or as the owner rewrote it). Publishing is a separate step. */
export function approveDraft(deps: PipelineDeps, id: string): StoredDraft {
  const d = requirePending(deps, id);
  const final = d.final ?? d.draft;
  setDraftStatus(deps, id, "approved", { final });
  const events = eventsForDraft(deps.db, id);
  for (const e of events) updateEvent(deps.db, e.id, { status: "approved" });
  labelFormat(deps, events, formatLabel(final));
  return getDraft(deps, id)!;
}

export function rejectDraft(deps: PipelineDeps, id: string, reason?: string): StoredDraft {
  requirePending(deps, id);
  setDraftStatus(deps, id, "rejected", { note: reason });
  for (const e of eventsForDraft(deps.db, id)) updateEvent(deps.db, e.id, { status: "rejected", reason: reason ?? "rejected by the owner" });
  return getDraft(deps, id)!;
}

/** A reason sent after the rejection, kept for the reflect job. */
export function noteRejection(deps: PipelineDeps, id: string, reason: string): void {
  deps.db.prepare("UPDATE drafts SET owner_note = ?, updated_at = ? WHERE id = ?").run(reason, now(), id);
}

/**
 * The owner's own text replaces the draft. Posts are separated by a line with only "---".
 * Claims are carried over from the draft so the checks still have something to verify against.
 */
export function replaceDraftText(deps: PipelineDeps, id: string, text: string): StoredDraft {
  const d = requirePending(deps, id);
  const parts = text.split(/^\s*---\s*$/m).map((p) => p.trim()).filter(Boolean);
  const allClaims = [...new Set(d.draft.posts.flatMap((p) => p.claims))];
  const final = DraftSchema.parse({ format: d.draft.format, posts: parts.map((t) => ({ text: t, claims: allClaims })), linkReply: d.draft.linkReply });
  const briefs = eventsForDraft(deps.db, id).map((e) => e.brief as ChangeBrief);
  const issues = runChecks(final, briefs, deps.project);
  deps.db.prepare("UPDATE drafts SET final = ?, checks = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(final), JSON.stringify(issues), now(), id);
  return getDraft(deps, id)!;
}

/** Rewrites a pending draft following an owner instruction; the old one is superseded. */
export async function reviseDraft(deps: PipelineDeps, id: string, instruction: string): Promise<{ events: ChangeEvent[]; draft: ComposedDraft }> {
  const d = requirePending(deps, id);
  const events = eventsForDraft(deps.db, id);
  const draft = await composeDraft({ format: d.draft.format, briefs: events.map((e) => e.brief as ChangeBrief), previous: d.final ?? d.draft, instruction }, deps);
  setDraftStatus(deps, id, "superseded", { note: `rewritten: ${instruction}` });
  for (const e of events) updateEvent(deps.db, e.id, { draftId: draft.id });
  return { events: events.map((e) => getEvent(deps.db, e.id)!), draft };
}

/** The owner wants another format for a pending draft: skip, hold, or rewrite as post/thread. */
export async function reformatDraft(deps: PipelineDeps, id: string, format: Format): Promise<Outcome[]> {
  requirePending(deps, id);
  const events = eventsForDraft(deps.db, id);
  setDraftStatus(deps, id, "superseded", { note: `owner chose ${format}` });
  labelFormat(deps, events, format);
  if (format === "post" || format === "thread") {
    const main = events[events.length - 1];
    for (const e of events.slice(0, -1)) updateEvent(deps.db, e.id, { status: "held", format: "hold" });
    updateEvent(deps.db, main.id, { status: "briefed" });
    return [await draftFor(getEvent(deps.db, main.id)!, format, deps, { mergeWithHeld: events.length > 1 })];
  }
  const outcomes: Outcome[] = [];
  for (const e of events) {
    updateEvent(deps.db, e.id, { status: "briefed" });
    outcomes.push(await applyFormat(getEvent(deps.db, e.id)!, format, deps));
  }
  return outcomes;
}

/** The owner answered "which format?" for an event the decision model wasn't sure about. */
export async function answerFormat(deps: PipelineDeps, eventId: string, format: Format): Promise<Outcome> {
  const event = getEvent(deps.db, eventId);
  if (!event || event.project !== deps.project.id) throw new Error(`Unknown change ${eventId}`);
  if (event.status !== "awaiting_format") throw new Error(`PR #${event.pr} is already ${event.status}`);
  if (event.decisionId) recordOwnerAnswers(event.decisionId, { format }, deps.db);
  updateEvent(deps.db, event.id, { status: "briefed" });
  return applyFormat(getEvent(deps.db, event.id)!, format, deps, { reason: "chosen by the owner" });
}
