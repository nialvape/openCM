import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../core/paths.js";
import { runAgentJson } from "../core/structured.js";
import { now } from "../store/db.js";
import { renderDraft, type Draft } from "./draft.js";
import type { PipelineDeps } from "./types.js";

export interface ReflectCase {
  draftId: string;
  kind: "rejected" | "edited" | "rewritten";
  draft: string;
  final?: string;
  note?: string;
  updatedAt: string;
}

export interface LessonProposal {
  id: number;
  text: string;
  evidence: string[];
  reason: string;
  review: string;
}

const ProposalsSchema = z.object({
  proposals: z.array(z.object({ lesson: z.string().min(5).max(300), evidence: z.array(z.string()).min(1), reason: z.string() })).max(5),
});
const ReviewSchema = z.object({ reviews: z.array(z.object({ index: z.number().int(), keep: z.boolean(), why: z.string() })) });

function lastReflect(deps: PipelineDeps): string {
  const row = deps.db.prepare("SELECT MAX(last_draft_at) AS t FROM reflect_runs WHERE project = ?").get(deps.project.id) as { t: string | null };
  return row.t ?? "";
}

/** Drafts the owner corrected since the last reflection: rejected, edited by hand, or sent back with an instruction. */
export function reflectCases(deps: PipelineDeps): ReflectCase[] {
  const rows = deps.db
    .prepare(
      `SELECT id, status, content, final, owner_note, updated_at FROM drafts WHERE project = ? AND updated_at > ? AND (
         status = 'rejected' OR (status IN ('approved', 'published') AND final IS NOT NULL AND final != content)
         OR (status = 'superseded' AND owner_note LIKE 'rewritten:%')) ORDER BY updated_at`,
    )
    .all(deps.project.id, lastReflect(deps)) as { id: string; status: string; content: string; final: string | null; owner_note: string | null; updated_at: string }[];
  return rows.map((r) => ({
    draftId: r.id,
    kind: r.status === "rejected" ? "rejected" : r.status === "superseded" ? "rewritten" : "edited",
    draft: renderDraft(JSON.parse(r.content) as Draft),
    final: r.final && r.status !== "rejected" ? renderDraft(JSON.parse(r.final) as Draft) : undefined,
    note: r.owner_note ?? undefined,
    updatedAt: r.updated_at,
  }));
}

export const lessonsFile = (projectId: string) => join(paths.projectDir(projectId), "lessons.md");

function renderCases(cases: ReflectCase[]): string {
  return cases
    .map((c) =>
      [
        `### case ${c.draftId} (${c.kind})`,
        `Draft:\n${c.draft}`,
        c.final ? `What the owner published instead:\n${c.final}` : "",
        c.note ? `Owner's note: ${c.note.replace(/^rewritten: /, "asked to rewrite: ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

/**
 * Turns the owner's corrections into proposed lessons: the reflect role proposes, citing the cases;
 * a reviewer from another model family keeps only the ones the evidence supports; the owner decides.
 * Nothing is written to lessons.md here.
 */
export async function reflect(deps: PipelineDeps, force = false): Promise<LessonProposal[]> {
  const cases = reflectCases(deps);
  if (cases.length === 0 || (!force && cases.length < deps.harness.memory.reflectAfter)) return [];
  const file = lessonsFile(deps.project.id);
  const current = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  const known = new Set(cases.map((c) => c.draftId));

  const { value: proposed } = await runAgentJson(ProposalsSchema, {
    role: "reflect",
    projectId: deps.project.id,
    task: `Current lessons:\n${current || "(none yet)"}\n\nCorrections by the maintainer:\n\n${renderCases(cases)}`,
    harness: deps.harness,
    db: deps.db,
    model: deps.models?.reflect,
  });
  // A lesson must cite at least one real case; invented evidence is dropped by code, not by trust.
  const grounded = proposed.proposals
    .map((p) => ({ ...p, evidence: p.evidence.filter((e) => known.has(e)) }))
    .filter((p) => p.evidence.length > 0);

  let kept: { p: (typeof grounded)[number]; why: string }[] = [];
  if (grounded.length) {
    const { value: reviewed } = await runAgentJson(ReviewSchema, {
      role: "reviewer",
      projectId: deps.project.id,
      task: [
        `Corrections by the maintainer:\n\n${renderCases(cases)}`,
        `Current lessons:\n${current || "(none yet)"}`,
        `Proposed lessons:\n${grounded.map((p, i) => `${i}. ${p.lesson}\n   evidence: ${p.evidence.join(", ")}\n   reason: ${p.reason}`).join("\n")}`,
      ].join("\n\n"),
      harness: deps.harness,
      db: deps.db,
      model: deps.models?.reviewer,
    });
    kept = reviewed.reviews.filter((r) => r.keep && grounded[r.index]).map((r) => ({ p: grounded[r.index], why: r.why }));
  }

  deps.db.prepare("INSERT INTO reflect_runs (project, last_draft_at, ran_at) VALUES (?, ?, ?)").run(deps.project.id, cases[cases.length - 1].updatedAt, now());
  return kept.map(({ p, why }) => {
    const res = deps.db
      .prepare("INSERT INTO lesson_proposals (project, text, evidence, reason, review, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
      .run(deps.project.id, p.lesson, JSON.stringify(p.evidence), p.reason, why, now());
    return { id: Number(res.lastInsertRowid), text: p.lesson, evidence: p.evidence, reason: p.reason, review: why };
  });
}

export function pendingLessons(deps: PipelineDeps): LessonProposal[] {
  return (deps.db.prepare("SELECT * FROM lesson_proposals WHERE project = ? AND status = 'pending' ORDER BY id").all(deps.project.id) as any[]).map((r) => ({
    id: r.id,
    text: r.text,
    evidence: JSON.parse(r.evidence),
    reason: r.reason,
    review: r.review,
  }));
}

/**
 * The owner accepted a lesson: code appends it to the project's lessons.md, which every role
 * reads. That changes the harness version, so the next eval measures the lesson's effect.
 */
export function decideLesson(deps: PipelineDeps, id: number, accept: boolean): LessonProposal {
  const row = deps.db.prepare("SELECT * FROM lesson_proposals WHERE id = ? AND project = ?").get(id, deps.project.id) as any;
  if (!row) throw new Error(`Lesson proposal ${id} not found`);
  if (row.status !== "pending") throw new Error(`That lesson was already ${row.status}`);
  deps.db.prepare("UPDATE lesson_proposals SET status = ?, decided_at = ? WHERE id = ?").run(accept ? "accepted" : "discarded", now(), id);
  if (accept) {
    const file = lessonsFile(deps.project.id);
    const sep = existsSync(file) && !readFileSync(file, "utf8").endsWith("\n") ? "\n" : "";
    appendFileSync(file, `${sep}- ${row.text}\n`);
    deps.db
      .prepare("INSERT INTO memory_items (project, kind, text, source_draft, score, created_at, updated_at) VALUES (?, 'lesson', ?, NULL, 0, ?, ?)")
      .run(deps.project.id, row.text, now(), now());
  }
  return { id, text: row.text, evidence: JSON.parse(row.evidence), reason: row.reason, review: row.review };
}
