import { InlineKeyboard } from "grammy";
import { renderDraft, weightedScore } from "../../pipeline/draft.js";
import type { FormatDecision } from "../../pipeline/decide.js";
import { FORMATS, type Format } from "../../pipeline/decide.js";
import type { LessonProposal } from "../../pipeline/reflect.js";
import type { StoredDraft } from "../../pipeline/review.js";
import type { ChangeEvent } from "../../store/events.js";

/** Actions on a draft card. Callback data stays under Telegram's 64-byte limit: "d:<uuid>:<action>". */
export type DraftAction = "approve" | "edit" | "reject" | "publish" | `to_${Format}`;

export type Callback =
  | { kind: "draft"; draftId: string; action: DraftAction }
  | { kind: "format"; eventId: string; format: Format }
  | { kind: "lesson"; lessonId: number; accept: boolean };

export function parseCallback(data: string): Callback | undefined {
  const [prefix, ...rest] = data.split(":");
  const tail = rest.pop();
  const ref = rest.join(":");
  if (!ref || !tail) return undefined;
  if (prefix === "d" && (["approve", "edit", "reject", "publish"].includes(tail) || FORMATS.some((f) => tail === `to_${f}`))) return { kind: "draft", draftId: ref, action: tail as DraftAction };
  if (prefix === "f" && (FORMATS as string[]).includes(tail)) return { kind: "format", eventId: ref, format: tail as Format };
  if (prefix === "l" && /^\d+$/.test(ref) && (tail === "accept" || tail === "discard")) return { kind: "lesson", lessonId: Number(ref), accept: tail === "accept" };
  return undefined;
}

const LABELS: Record<Format, string> = { skip: "Skip", hold: "Hold for digest", post: "Single post", thread: "Thread" };

export function draftCard(d: StoredDraft, events: ChangeEvent[]): { text: string; keyboard: InlineKeyboard } {
  const shown = d.final ?? d.draft;
  const prs = events.map((e) => `#${e.pr} ${e.title}`).join("\n");
  const score = d.critique ? `critic ${weightedScore(d.critique)}/5` : "no critic score";
  const header = `📝 ${shown.format.toUpperCase()} draft · ${score} · ${d.revisions} rewrites${d.final ? " · edited by you" : ""}`;
  const issues = d.issues.length ? `\n⚠️ Checks still failing:\n${d.issues.map((i) => `- ${i.where}: ${i.message}`).join("\n")}\n` : "";
  const fixes = d.critique?.fixes.length && d.critique.verdict === "revise" ? `\n🧐 Critic: ${d.critique.fixes.join(" · ")}\n` : "";
  const links = events.map((e) => e.url).join("\n");
  const text = `${header}\n${prs}\n${issues}${fixes}\n${renderDraft(shown)}\n\n${links}`;

  const kb = new InlineKeyboard().text("✅ Approve", `d:${d.id}:approve`).text("✏️ Edit", `d:${d.id}:edit`).text("🗑 Reject", `d:${d.id}:reject`).row();
  for (const f of FORMATS) if (f !== shown.format && !(f === "hold" && shown.format === "digest")) kb.text(`→ ${LABELS[f]}`, `d:${d.id}:to_${f}`);
  return { text, keyboard: kb };
}

export function formatQuestion(event: ChangeEvent, decision: Pick<FormatDecision, "probabilities" | "reason">): { text: string; keyboard: InlineKeyboard } {
  const p = decision.probabilities;
  const odds = p ? FORMATS.map((f) => `${LABELS[f]} ${Math.round((p[f] ?? 0) * 100)}%`).join(" · ") : "no probabilities";
  const summary = (event.brief as { summary?: string } | undefined)?.summary ?? "";
  const text = `❓ How much content does #${event.pr} deserve?\n${event.title}\n\n${summary}\n\nModel: ${odds}\n(${decision.reason})\n\n${event.url}`;
  const kb = new InlineKeyboard();
  FORMATS.forEach((f, i) => {
    kb.text(LABELS[f], `f:${event.id}:${f}`);
    if (i === 1) kb.row();
  });
  return { text, keyboard: kb };
}

export const EDIT_HELP = "Send an instruction to rewrite it (e.g. \"más corto, sin emojis\"), or start your message with = to use your exact text. In a thread, separate posts with a line containing only ---.";

/** Shown when publishing failed after approval; publishing again skips the parts already posted. */
export function retryPublishKeyboard(draftId: string): InlineKeyboard {
  return new InlineKeyboard().text("🔁 Retry publishing", `d:${draftId}:publish`);
}

export function lessonCard(p: LessonProposal): { text: string; keyboard: InlineKeyboard } {
  const text = `💡 Proposed lesson, from your corrections:\n\n${p.text}\n\nWhy: ${p.reason}\nReviewer: ${p.review}\nBased on ${p.evidence.length} case(s).\n\nIf you accept it, it's added to lessons.md and every role reads it from now on.`;
  return { text, keyboard: new InlineKeyboard().text("✅ Add lesson", `l:${p.id}:accept`).text("✖️ Discard", `l:${p.id}:discard`) };
}
