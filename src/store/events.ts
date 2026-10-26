import type { DatabaseSync } from "node:sqlite";
import { now } from "./db.js";

/**
 * One merged PR moving through the pipeline. Status order:
 * new → skipped | briefed → (decided) → held | drafted → approved | rejected → published.
 * `failed` keeps the error so the next poll can retry.
 */
export type EventStatus = "new" | "skipped" | "briefed" | "held" | "awaiting_format" | "drafted" | "approved" | "rejected" | "published" | "failed";

export interface ChangeEvent {
  id: string;
  project: string;
  pr: number;
  title: string;
  url: string;
  mergedAt: string;
  version?: string;
  status: EventStatus;
  reason?: string;
  brief?: unknown;
  format?: string;
  decisionId?: string;
  draftId?: string;
  attempts: number;
}

const eventId = (project: string, pr: number) => `${project}:pr:${pr}`;

function fromRow(r: any): ChangeEvent {
  return {
    id: r.id,
    project: r.project,
    pr: r.pr,
    title: r.title,
    url: r.url,
    mergedAt: r.merged_at,
    version: r.version ?? undefined,
    status: r.status,
    reason: r.reason ?? undefined,
    brief: r.brief ? JSON.parse(r.brief) : undefined,
    format: r.format ?? undefined,
    decisionId: r.decision_id ?? undefined,
    draftId: r.draft_id ?? undefined,
    attempts: r.attempts,
  };
}

export function getCursor(db: DatabaseSync, project: string): string | undefined {
  return (db.prepare("SELECT merged_after FROM cursors WHERE project = ?").get(project) as { merged_after: string } | undefined)?.merged_after;
}

export function setCursor(db: DatabaseSync, project: string, mergedAfter: string): void {
  db.prepare("INSERT INTO cursors (project, merged_after, updated_at) VALUES (?, ?, ?) ON CONFLICT(project) DO UPDATE SET merged_after = excluded.merged_after, updated_at = excluded.updated_at").run(
    project,
    mergedAfter,
    now(),
  );
}

/** Records a merged PR once; returns false when it was already known. */
export function addEvent(db: DatabaseSync, e: { project: string; pr: number; title: string; url: string; mergedAt: string }): boolean {
  const res = db
    .prepare("INSERT OR IGNORE INTO events (id, project, pr, title, url, merged_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)")
    .run(eventId(e.project, e.pr), e.project, e.pr, e.title, e.url, e.mergedAt, now(), now());
  return res.changes > 0;
}

export function getEvent(db: DatabaseSync, id: string): ChangeEvent | undefined {
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  return row ? fromRow(row) : undefined;
}

export function getEventByPr(db: DatabaseSync, project: string, pr: number): ChangeEvent | undefined {
  return getEvent(db, eventId(project, pr));
}

export function eventsWithStatus(db: DatabaseSync, project: string, ...statuses: EventStatus[]): ChangeEvent[] {
  const marks = statuses.map(() => "?").join(", ");
  return db.prepare(`SELECT * FROM events WHERE project = ? AND status IN (${marks}) ORDER BY merged_at`).all(project, ...statuses).map(fromRow);
}

/** Events merged after `afterIso` (exclusive) up to and including `untilIso`, oldest first. */
export function eventsBetween(db: DatabaseSync, project: string, afterIso: string, untilIso: string): ChangeEvent[] {
  return db.prepare("SELECT * FROM events WHERE project = ? AND merged_at > ? AND merged_at <= ? ORDER BY merged_at").all(project, afterIso, untilIso).map(fromRow);
}

/** The last version bump merged before `beforeIso`, if any. */
export function previousRelease(db: DatabaseSync, project: string, beforeIso: string): ChangeEvent | undefined {
  const row = db.prepare("SELECT * FROM events WHERE project = ? AND version IS NOT NULL AND merged_at < ? ORDER BY merged_at DESC LIMIT 1").get(project, beforeIso);
  return row ? fromRow(row) : undefined;
}

export function updateEvent(
  db: DatabaseSync,
  id: string,
  patch: Partial<Pick<ChangeEvent, "status" | "reason" | "brief" | "format" | "version" | "decisionId" | "draftId">> & { incAttempts?: boolean },
): void {
  const sets: string[] = ["updated_at = ?"];
  const args: (string | number | null)[] = [now()];
  const put = (col: string, v: string | null) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (patch.status !== undefined) put("status", patch.status);
  if (patch.reason !== undefined) put("reason", patch.reason);
  if (patch.brief !== undefined) put("brief", JSON.stringify(patch.brief));
  if (patch.format !== undefined) put("format", patch.format);
  if (patch.version !== undefined) put("version", patch.version);
  if (patch.decisionId !== undefined) put("decision_id", patch.decisionId);
  if (patch.draftId !== undefined) put("draft_id", patch.draftId);
  if (patch.incAttempts) sets.push("attempts = attempts + 1");
  db.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
}

/**
 * The PRs a draft is about, from the draft's own list. Events only point at their latest draft, so
 * looking them up that way left an older draft with no PRs, and editing it wrote without any brief.
 */
export function eventsForDraft(db: DatabaseSync, draftId: string): ChangeEvent[] {
  const draft = db.prepare("SELECT project, prs FROM drafts WHERE id = ?").get(draftId) as { project: string; prs: string } | undefined;
  const prs = draft ? (JSON.parse(draft.prs) as number[]) : [];
  if (!draft || prs.length === 0) return db.prepare("SELECT * FROM events WHERE draft_id = ? ORDER BY merged_at").all(draftId).map(fromRow);
  return db
    .prepare(`SELECT * FROM events WHERE project = ? AND pr IN (${prs.map(() => "?").join(", ")}) ORDER BY merged_at`)
    .all(draft.project, ...prs)
    .map(fromRow);
}
