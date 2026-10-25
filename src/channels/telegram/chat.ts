import type { DatabaseSync } from "node:sqlite";
import type { LanguageModel, ModelMessage } from "ai";
import { z } from "zod";
import type { HarnessConfig, ProjectConfig } from "../../core/config.js";
import { conversationChars, renderForSummary, splitForCompaction, withSummary } from "../../core/compact.js";
import { harnessVersions } from "../../core/context.js";
import { runAgent, type AgentTool } from "../../core/loop.js";
import { now } from "../../store/db.js";

export interface ChatDeps {
  project: ProjectConfig;
  harness: HarnessConfig;
  db: DatabaseSync;
  /** Tools over the tracked repo (repo_list, get_pr…); send_message is added per message. */
  repoTools: Record<string, AgentTool>;
  /**
   * Runs the pipeline for one merged PR and sends the owner its draft card; returns what happened.
   * Drafts go through the writer, checks and critic, and reach X only when the owner approves the card.
   */
  draftPr?: (pr: number, format?: "post" | "thread") => Promise<string>;
  /** Injected for tests; otherwise each role's model from config. */
  models?: { chat?: LanguageModel; compactor?: LanguageModel };
}

export type Send = (text: string) => Promise<void>;

function addTranscript(db: DatabaseSync, chatId: string, author: "owner" | "bot", text: string, runId?: string): void {
  db.prepare("INSERT INTO chat_transcript (chat_id, author, text, run_id, created_at) VALUES (?, ?, ?, ?, ?)").run(chatId, author, text, runId ?? null, now());
}

function loadSession(db: DatabaseSync, chatId: string): { messages: ModelMessage[]; harnessVersion?: string } {
  const row = db.prepare("SELECT messages, harness_version FROM chat_sessions WHERE chat_id = ?").get(chatId) as { messages: string; harness_version: string | null } | undefined;
  return row ? { messages: JSON.parse(row.messages), harnessVersion: row.harness_version ?? undefined } : { messages: [] };
}

function saveSession(db: DatabaseSync, chatId: string, project: string, messages: ModelMessage[], harnessVersion: string, summary?: string): void {
  db.prepare(
    `INSERT INTO chat_sessions (chat_id, project, messages, summary, harness_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET project = excluded.project, messages = excluded.messages,
       summary = COALESCE(excluded.summary, chat_sessions.summary), harness_version = excluded.harness_version, updated_at = excluded.updated_at`,
  ).run(chatId, project, JSON.stringify(messages), summary ?? null, harnessVersion, now());
}

export function resetSession(db: DatabaseSync, chatId: string): void {
  db.prepare("DELETE FROM chat_sessions WHERE chat_id = ?").run(chatId);
}

/** Replaces the older part of a long session with a summary written by the compactor role. */
async function compactIfNeeded(messages: ModelMessage[], deps: ChatDeps): Promise<{ messages: ModelMessage[]; summary?: string }> {
  if (conversationChars(messages) <= deps.harness.chat.compactAtChars) return { messages };
  const split = splitForCompaction(messages, deps.harness.chat.keepRecentTurns);
  if (!split) return { messages };
  const result = await runAgent({
    role: "compactor",
    projectId: deps.project.id,
    task: `Conversation to summarize:\n\n${renderForSummary(split.older)}`,
    harness: deps.harness,
    db: deps.db,
    model: deps.models?.compactor,
  });
  // A failed summary must not lose the conversation: keep it whole and try again next message.
  if (result.status !== "done" || !result.text.trim()) return { messages };
  return { messages: withSummary(split.tail, result.text.trim()), summary: result.text.trim() };
}

function sendMessageTool(send: Send, db: DatabaseSync, chatId: string): AgentTool<{ text: string }> {
  return {
    description:
      "Sends a short progress note to the owner right away, e.g. 'Looking at PR #16…', when the answer will take several steps. Your final answer is delivered automatically; don't send it with this tool.",
    inputSchema: z.object({ text: z.string().min(1).max(500).describe("The note, one or two sentences") }),
    execute: async ({ text }) => {
      await send(text);
      addTranscript(db, chatId, "bot", text);
      return "sent";
    },
  };
}

function draftForPrTool(draftPr: NonNullable<ChatDeps["draftPr"]>): AgentTool<{ pr: number; format?: "post" | "thread" }> {
  return {
    description:
      "Drafts content about one merged PR the way every draft is made (writer, checks, critic) and sends the owner a draft card with approve/edit/format buttons. Use it whenever the owner asks for a post, thread or tweet about a change. Leave format out to let the format decision choose; set it only when the owner named one.",
    inputSchema: z.object({
      pr: z.number().int().positive().describe("The merged PR's number; find it with list_prs if the owner didn't say"),
      format: z.enum(["post", "thread"]).optional().describe("Only when the owner asked for one"),
    }),
    execute: async ({ pr, format }) => draftPr(pr, format),
  };
}

/**
 * One owner message → one chat run. The session (what the model sees) and the transcript (what
 * was said in Telegram) are stored apart; the session may be compacted, the transcript never is.
 */
export async function handleOwnerMessage(chatId: string, text: string, send: Send, deps: ChatDeps): Promise<string> {
  const { db } = deps;
  addTranscript(db, chatId, "owner", text);

  const today = new Date().toISOString().slice(0, 10);
  const turn: ModelMessage = { role: "user", content: `(Today is ${today}. Tracked repo: ${deps.project.repo}.)\n\n${text}` };
  // The new message counts as the most recent turn, so it's compacted together with the session:
  // the last message out is always this turn (with the summary prefixed when one was made).
  const session = loadSession(db, chatId);
  // A session made under other instructions or tools teaches the model the old behavior by example
  // (it kept writing posts by hand after it got draft_for_pr), so it starts over; the transcript stays.
  const stale = session.messages.length > 0 && session.harnessVersion !== harnessVersions(deps.project.id, deps.harness).chat;
  if (stale) await send("My instructions or tools changed since our last messages, so I'm starting a fresh conversation.");
  const compacted = await compactIfNeeded([...(stale ? [] : session.messages), turn], deps);
  const latest = compacted.messages[compacted.messages.length - 1];
  const result = await runAgent({
    role: "chat",
    projectId: deps.project.id,
    task: latest.content as string,
    history: compacted.messages.slice(0, -1),
    tools: { ...deps.repoTools, send_message: sendMessageTool(send, db, chatId), ...(deps.draftPr ? { draft_for_pr: draftForPrTool(deps.draftPr) } : {}) },
    harness: deps.harness,
    db,
    model: deps.models?.chat,
  });
  saveSession(db, chatId, deps.project.id, result.messages, result.harnessVersion, compacted.summary);

  const reply = result.text.trim() || statusReply(result.status);
  addTranscript(db, chatId, "bot", reply, result.runId);
  return reply;
}

function statusReply(status: string): string {
  switch (status) {
    case "max_steps":
      return "I ran out of steps before finishing. Ask again more narrowly, or raise roles.chat.maxSteps in config.";
    case "length":
      return "My answer hit the output limit before I finished. Ask again more narrowly, or raise roles.chat.maxOutputTokens in config.";
    case "budget":
      return "I stopped at the cost limit for one answer (roles.chat.maxCostUsd in config).";
    case "error":
      return "Something failed while answering; the trace in data/traces/ has the details.";
    default:
      return "(no answer)";
  }
}

/** Spend and activity, for /status. */
export function statusSummary(db: DatabaseSync): string {
  const today = new Date().toISOString().slice(0, 10);
  const agg = (where: string, ...args: string[]) =>
    db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost FROM runs WHERE ${where}`).get(...args) as { runs: number; cost: number };
  const day = agg("created_at >= ?", today);
  const all = agg("1 = 1");
  const recent = db.prepare("SELECT role, status, steps, cost_usd, created_at FROM runs ORDER BY created_at DESC LIMIT 5").all() as {
    role: string;
    status: string;
    steps: number;
    cost_usd: number | null;
    created_at: string;
  }[];
  const usd = (n: number | null) => (n == null ? "?" : `$${n.toFixed(4)}`);
  return [
    `Today: ${day.runs} runs, ${usd(day.cost)}`,
    `All time: ${all.runs} runs, ${usd(all.cost)}`,
    "",
    "Last runs:",
    ...recent.map((r) => `${r.created_at.slice(5, 16).replace("T", " ")} ${r.role} ${r.status} (${r.steps} steps, ${usd(r.cost_usd)})`),
  ].join("\n");
}
