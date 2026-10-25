import type { DatabaseSync } from "node:sqlite";
import { now } from "../store/db.js";
import { renderDraft, type Draft } from "./draft.js";
import type { PipelineDeps } from "./types.js";

/** Credit per owner outcome for the examples a draft was written with. */
export const OUTCOME_CREDIT = { approved: 1, edited: 0.3, rejected: -1 } as const;

export interface MemoryItem {
  id: number;
  kind: "example" | "lesson";
  format?: string;
  text: string;
  score: number;
  uses: number;
}

/** Best examples for a format: highest score first, newer first on ties. */
export function selectExamples(db: DatabaseSync, project: string, format: string, limit: number): MemoryItem[] {
  if (limit <= 0) return [];
  return db
    .prepare("SELECT id, kind, format, text, score, uses FROM memory_items WHERE project = ? AND kind = 'example' AND active = 1 AND format = ? ORDER BY score DESC, created_at DESC LIMIT ?")
    .all(project, format, limit) as unknown as MemoryItem[];
}

export function examplesBlock(items: MemoryItem[]): string {
  if (items.length === 0) return "";
  return [
    "Posts the maintainer approved before, best first. Match their voice and level of detail; don't copy their content:",
    ...items.map((i, n) => `--- example ${n + 1} ---\n${i.text}`),
  ].join("\n");
}

/** Which memory a draft was written with: the evidence used to credit or blame it later. */
export function recordUsage(db: DatabaseSync, draftId: string, items: MemoryItem[]): void {
  for (const i of items) {
    db.prepare("INSERT OR IGNORE INTO memory_usage (draft_id, item_id) VALUES (?, ?)").run(draftId, i.id);
    db.prepare("UPDATE memory_items SET uses = uses + 1, updated_at = ? WHERE id = ?").run(now(), i.id);
  }
}

/**
 * Applies a signal once per draft (`signal` names it, e.g. "outcome" or "metrics:24"). Credit goes
 * to the examples the draft used and to the example that came out of the draft, if any.
 */
export function credit(db: DatabaseSync, draftId: string, signal: string, delta: number): boolean {
  const inserted = db.prepare("INSERT OR IGNORE INTO memory_credits (draft_id, signal, delta, created_at) VALUES (?, ?, ?, ?)").run(draftId, signal, delta, now());
  if (inserted.changes === 0) return false;
  db.prepare("UPDATE memory_items SET score = score + ?, updated_at = ? WHERE id IN (SELECT item_id FROM memory_usage WHERE draft_id = ?) OR source_draft = ?").run(delta, now(), draftId, draftId);
  return true;
}

/** Keeps the best `max` active examples per project; the rest stop being shown. */
export function evict(db: DatabaseSync, project: string, max: number): number {
  const res = db
    .prepare(
      `UPDATE memory_items SET active = 0, updated_at = ? WHERE project = ? AND kind = 'example' AND active = 1 AND id NOT IN (
         SELECT id FROM memory_items WHERE project = ? AND kind = 'example' AND active = 1 ORDER BY score DESC, created_at DESC LIMIT ?)`,
    )
    .run(now(), project, project, max);
  return Number(res.changes);
}

/** After the owner decides: credit what the draft used, and keep approved text as a new example. */
export function learnFromOutcome(deps: PipelineDeps, draftId: string, outcome: keyof typeof OUTCOME_CREDIT, final?: Draft): void {
  credit(deps.db, draftId, "outcome", OUTCOME_CREDIT[outcome]);
  if (outcome !== "rejected" && final) {
    deps.db
      .prepare("INSERT INTO memory_items (project, kind, format, text, source_draft, score, created_at, updated_at) VALUES (?, 'example', ?, ?, ?, ?, ?, ?)")
      .run(deps.project.id, final.format, renderDraft(final), draftId, OUTCOME_CREDIT[outcome], now(), now());
    evict(deps.db, deps.project.id, deps.harness.memory.maxExamples);
  }
}

/** Likes + 2×reposts + replies + quotes: a reader acting on the post counts more than one passing by. */
const ENGAGEMENT = "SUM(m.likes + 2 * m.reposts + m.replies + m.quotes)";

/**
 * Credits drafts by engagement at a checkpoint, relative to the project's median, in [-1, 1].
 * Delayed, outside the model, and the signal the owner actually cares about.
 */
export function creditFromMetrics(deps: PipelineDeps, afterHours: number): number {
  const rows = deps.db
    .prepare(
      `SELECT p.draft_id AS draft, ${ENGAGEMENT} AS engagement FROM posts p JOIN post_metrics m ON m.x_id = p.x_id
       WHERE p.project = ? AND m.after_hours = ? GROUP BY p.draft_id`,
    )
    .all(deps.project.id, afterHours) as { draft: string; engagement: number }[];
  if (rows.length < 3) return 0; // A median of one or two posts says nothing.
  const sorted = rows.map((r) => r.engagement).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let credited = 0;
  for (const r of rows) {
    const delta = Math.max(-1, Math.min(1, (r.engagement - median) / Math.max(median, 1)));
    if (credit(deps.db, r.draft, `metrics:${afterHours}`, delta)) credited++;
  }
  return credited;
}
