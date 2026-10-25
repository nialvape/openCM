import { detectVersionBump, getPullRequest, mergedPullsSince, prefilter } from "../sources/github/changes.js";
import { addEvent, eventsWithStatus, getCursor, getEvent, setCursor, updateEvent, type ChangeEvent } from "../store/events.js";
import { buildBrief, type ChangeBrief } from "./brief.js";
import { buildPatchNotes, type PatchNotes } from "./patch-notes.js";
import type { PipelineDeps } from "./types.js";

/** A failed event is retried on later polls until it has failed this many times. */
const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StepResult =
  | { pr: number; status: "skipped"; reason: string }
  | { pr: number; status: "briefed"; brief: ChangeBrief; patchNotes?: PatchNotes }
  | { pr: number; status: "failed"; reason: string };

/**
 * Records PRs merged since the cursor as new events. The first poll starts from `watch.startFrom`
 * or the last 24 hours, so it doesn't announce the project's whole history.
 */
export async function poll(deps: PipelineDeps, nowMs = Date.now()): Promise<ChangeEvent[]> {
  const { db, project } = deps;
  const after = getCursor(db, project.id) ?? project.watch.startFrom ?? new Date(nowMs - DAY_MS).toISOString();
  const merged = await mergedPullsSince(deps.gh, after);
  const added: ChangeEvent[] = [];
  for (const pr of merged) {
    if (addEvent(db, { project: project.id, pr: pr.number, title: pr.title, url: pr.html_url, mergedAt: pr.merged_at! })) {
      added.push(getEvent(db, `${project.id}:pr:${pr.number}`)!);
    }
  }
  setCursor(db, project.id, merged.length ? merged[merged.length - 1].merged_at! : after);
  return added;
}

/** Prefilter, version detection and brief for one event. Errors mark it failed for a later retry. */
export async function analyzeEvent(event: ChangeEvent, deps: PipelineDeps): Promise<StepResult> {
  try {
    const { pr, files } = await getPullRequest(deps.gh, event.pr);
    const filtered = prefilter(pr, files, deps.project);
    if (filtered.skip) {
      updateEvent(deps.db, event.id, { status: "skipped", reason: filtered.reason });
      return { pr: event.pr, status: "skipped", reason: filtered.reason! };
    }
    const version = detectVersionBump(files, deps.project);
    const brief = await buildBrief(pr, files, deps, version);
    updateEvent(deps.db, event.id, { status: "briefed", brief, ...(version ? { version } : {}) });
    const patchNotes = version ? await buildPatchNotes(getEvent(deps.db, event.id)!, deps) : undefined;
    return { pr: event.pr, status: "briefed", brief, patchNotes };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    updateEvent(deps.db, event.id, { status: "failed", reason, incAttempts: true });
    return { pr: event.pr, status: "failed", reason };
  }
}

/** Events the pipeline can move on: new, briefed but undecided, and failed with attempts left. */
export function pendingEvents(deps: PipelineDeps): ChangeEvent[] {
  return eventsWithStatus(deps.db, deps.project.id, "new", "briefed", "failed").filter((e) => e.status !== "failed" || e.attempts < MAX_ATTEMPTS);
}
