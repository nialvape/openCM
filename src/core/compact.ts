import type { ModelMessage } from "ai";

/** Size of a conversation as the provider will see it, in characters of JSON. */
export const conversationChars = (messages: ModelMessage[]) => JSON.stringify(messages).length;

/** A real turn by the person (string content), as opposed to tool results or summaries. */
const isUserTurn = (m: ModelMessage) => m.role === "user" && typeof m.content === "string";

/**
 * Splits a conversation into an older part to summarize and a recent tail to keep verbatim.
 * The tail always starts at a user turn, so tool calls and their results are never separated.
 * Returns undefined when there's nothing old enough to summarize.
 */
export function splitForCompaction(messages: ModelMessage[], keepRecentTurns: number): { older: ModelMessage[]; tail: ModelMessage[] } | undefined {
  const turnStarts = messages.flatMap((m, i) => (isUserTurn(m) ? [i] : []));
  if (turnStarts.length <= keepRecentTurns) return undefined;
  const cut = turnStarts[turnStarts.length - keepRecentTurns];
  if (cut === 0) return undefined;
  return { older: messages.slice(0, cut), tail: messages.slice(cut) };
}

/** Plain-text rendering of messages for the summarizer: who said what, tools by name only. */
export function renderForSummary(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      lines.push(`${m.role}: ${m.content}`);
      continue;
    }
    for (const part of m.content as any[]) {
      if (part.type === "text") lines.push(`${m.role}: ${part.text}`);
      else if (part.type === "tool-call") lines.push(`${m.role} used ${part.toolName}(${JSON.stringify(part.input).slice(0, 200)})`);
      else if (part.type === "tool-result") lines.push(`tool ${part.toolName} returned ${JSON.stringify(part.output).slice(0, 300)}`);
    }
  }
  return lines.join("\n");
}

/**
 * The summary rides as a prefix of the first kept user turn (not as a system prompt section), so
 * the cached system prefix stays the same across compactions.
 */
export function withSummary(tail: ModelMessage[], summary: string): ModelMessage[] {
  const [first, ...rest] = tail;
  if (!first || !isUserTurn(first)) throw new Error("Compaction tail must start with a user turn");
  return [{ role: "user", content: `[Summary of the earlier conversation]\n${summary}\n[End of summary]\n\n${first.content as string}` }, ...rest];
}
