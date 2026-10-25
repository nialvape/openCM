import { InlineKeyboard } from "grammy";
import { weightedScore, type Draft } from "../../pipeline/draft.js";
import { measure, X_LIMIT } from "../../tools/measure.js";
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

/** Critic notes shown on a card, and how long each may be: the post is what the owner reads first. */
const MAX_NOTES = 3;
const MAX_NOTE_CHARS = 180;
const RULE = "────────────";

const clipNote = (s: string) => (s.length > MAX_NOTE_CHARS ? `${s.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : s);

/** Each post with its exact X length, so a thread reads as a thread and a long post as one post. */
function renderPosts(d: Draft): string {
  const lengths = measure(d.posts.map((p) => p.text));
  const posts = d.posts.map((p, i) => {
    const label = d.posts.length > 1 ? `${i + 1}/${d.posts.length}` : "Post";
    return `${label} · ${lengths[i].length}/${X_LIMIT}${lengths[i].fits ? "" : " ⚠️"}\n${p.text}`;
  });
  if (d.linkReply) posts.push(`↳ Posted as a reply under it (has a link: costs about 13 posts)\n${d.linkReply}`);
  return posts.join("\n\n");
}

export function draftCard(d: StoredDraft, events: ChangeEvent[]): { text: string; keyboard: InlineKeyboard } {
  const shown = d.final ?? d.draft;
  const kind = shown.format === "thread" ? `THREAD of ${shown.posts.length} posts` : shown.format.toUpperCase();
  const score = d.critique ? ` · critic ${weightedScore(d.critique)}/5` : "";
  const header = `📝 ${kind}${score}${d.final ? " · edited by you" : ""}\n${events.map((e) => `#${e.pr} ${e.title}`).join("\n")}`;

  const notes: string[] = [];
  if (d.issues.length) notes.push(`⚠️ Checks still failing:\n${d.issues.map((i) => `- ${i.where}: ${i.message}`).join("\n")}`);
  // Only what the critic still objects to after the rewrites; the full critique stays in the database.
  if (d.critique?.verdict === "revise" && d.critique.fixes.length && !d.final) {
    const fixes = d.critique.fixes;
    const more = fixes.length > MAX_NOTES ? `\n(+${fixes.length - MAX_NOTES} more)` : "";
    notes.push(`🧐 Critic, still unresolved after ${d.revisions} rewrites:\n${fixes.slice(0, MAX_NOTES).map((f) => `- ${clipNote(f)}`).join("\n")}${more}`);
  }

  const text = [header, RULE, renderPosts(shown), RULE, ...notes, events.map((e) => e.url).join("\n")].join("\n\n");

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
