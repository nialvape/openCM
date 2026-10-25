import type { Experimental_DecisionModel } from "ai";
import { eventsWithStatus, getEvent, updateEvent, type ChangeEvent } from "../store/events.js";
import type { ChangeBrief } from "./brief.js";
import { applyGuards, decideFormat, type Format, type FormatDecision } from "./decide.js";
import { composeDraft, type ComposedDraft } from "./draft.js";
import type { PatchNotes } from "./patch-notes.js";
import type { PipelineDeps } from "./types.js";
import { analyzeEvent } from "./watch.js";

/** What happened to one event in one pass; the bot turns each outcome into a message. */
export type Outcome =
  | { kind: "skipped"; event: ChangeEvent; reason: string }
  | { kind: "failed"; event: ChangeEvent; reason: string }
  | { kind: "held"; event: ChangeEvent; reason: string }
  | { kind: "ask_format"; event: ChangeEvent; decision: FormatDecision }
  | { kind: "drafted"; events: ChangeEvent[]; draft: ComposedDraft; patchNotes?: PatchNotes };

const briefOf = (e: ChangeEvent) => e.brief as ChangeBrief;

/** Writes the draft for an event in a chosen format, merging held events when the decision says so. */
export async function draftFor(event: ChangeEvent, format: "post" | "thread", deps: PipelineDeps, opts: { mergeWithHeld?: boolean; wantsLink?: boolean } = {}): Promise<Outcome> {
  const held = opts.mergeWithHeld ? eventsWithStatus(deps.db, deps.project.id, "held") : [];
  const events = [...held, event];
  const draft = await composeDraft({ format, briefs: events.map(briefOf), wantsLink: opts.wantsLink }, deps);
  for (const e of events) updateEvent(deps.db, e.id, { status: "drafted", format, draftId: draft.id });
  return { kind: "drafted", events: events.map((e) => getEvent(deps.db, e.id)!), draft };
}

/** Applies a format chosen by the model or the owner to a briefed event. */
export async function applyFormat(event: ChangeEvent, format: Format, deps: PipelineDeps, decision?: Partial<FormatDecision>): Promise<Outcome> {
  const guarded = applyGuards(format, event, deps);
  const reason = guarded.reason ?? decision?.reason ?? format;
  switch (guarded.format) {
    case "skip":
      updateEvent(deps.db, event.id, { status: "skipped", format: "skip", reason });
      return { kind: "skipped", event, reason };
    case "hold":
      updateEvent(deps.db, event.id, { status: "held", format: "hold", reason });
      return { kind: "held", event: getEvent(deps.db, event.id)!, reason };
    default:
      return draftFor(event, guarded.format, deps, decision);
  }
}

/**
 * Moves one event as far as it can go without the owner: analyze → decide → draft. It stops at
 * `ask_format` (the owner picks) and `drafted` (the owner approves).
 */
export async function advance(event: ChangeEvent, deps: PipelineDeps, decisionModel?: Experimental_DecisionModel): Promise<Outcome> {
  let current = event;
  let patchNotes: PatchNotes | undefined;
  if (current.status === "new" || current.status === "failed") {
    const analyzed = await analyzeEvent(current, deps);
    current = getEvent(deps.db, current.id)!;
    if (analyzed.status === "skipped") return { kind: "skipped", event: current, reason: analyzed.reason };
    if (analyzed.status === "failed") return { kind: "failed", event: current, reason: analyzed.reason };
    patchNotes = analyzed.patchNotes;
  }
  if (current.status !== "briefed") throw new Error(`PR #${current.pr} is '${current.status}', nothing to advance`);

  try {
    const decision = await decideFormat(current, briefOf(current), deps, decisionModel);
    if (!decision.format) {
      updateEvent(deps.db, current.id, { status: "awaiting_format", decisionId: decision.decisionId, reason: decision.reason });
      return { kind: "ask_format", event: getEvent(deps.db, current.id)!, decision };
    }
    if (decision.decisionId) updateEvent(deps.db, current.id, { decisionId: decision.decisionId });
    const outcome = await applyFormat(current, decision.format, deps, decision);
    return outcome.kind === "drafted" ? { ...outcome, patchNotes } : outcome;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // The brief is kept: a retry starts from the decision, not from scratch.
    updateEvent(deps.db, current.id, { reason });
    return { kind: "failed", event: current, reason };
  }
}

/** Drafts a digest of held events when enough piled up, or right away with `force`. */
export async function maybeDigest(deps: PipelineDeps, force = false): Promise<Outcome | undefined> {
  const held = eventsWithStatus(deps.db, deps.project.id, "held");
  if (held.length === 0 || (!force && held.length < deps.project.posting.digestMinItems)) return undefined;
  const draft = await composeDraft({ format: "digest", briefs: held.map(briefOf) }, deps);
  for (const e of held) updateEvent(deps.db, e.id, { status: "drafted", format: "digest", draftId: draft.id });
  return { kind: "drafted", events: held.map((e) => getEvent(deps.db, e.id)!), draft };
}
