import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { isOwner, readBotEnv, splitMessage } from "./bot.js";
import { handleOwnerMessage, resetSession, statusSummary, type ChatDeps } from "./chat.js";
import { splitForCompaction, withSummary } from "../../core/compact.js";
import { ConfigError, type HarnessConfig } from "../../core/config.js";
import { openDb } from "../../store/db.js";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const call = (toolName: string, input: object) => ({
  content: [{ type: "tool-call" as const, toolCallId: `c-${toolName}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  usage,
  warnings: [],
});

const role = (tools: string[]) => ({ model: "mock:m", tools, maxSteps: 5, maxCostUsd: 1, plan: false });
const harness = (compactAtChars = 100_000): HarnessConfig => ({
  roles: { chat: role(["get_pr", "send_message"]), compactor: role([]) },
  maxToolOutputChars: 1000,
  pricing: {},
  decisions: { model: "mock:d", thresholds: { default: 0.8 } },
  chat: { compactAtChars, keepRecentTurns: 1 },
});

const fakeGetPr = {
  description: "get a PR",
  inputSchema: z.object({ number: z.number() }),
  execute: async ({ number }: { number: number }) => `PR #${number}: adds TUP support`,
};

const deps = (h: HarnessConfig, chat: MockLanguageModelV4, compactor?: MockLanguageModelV4): ChatDeps => ({
  project: { id: "p", repo: "o/r", branch: "main", language: "es", channels: {}, prefilter: { ignorePaths: [], ignoreLabels: [] }, harness: {} },
  harness: h,
  db: openDb(":memory:"),
  repoTools: { get_pr: fakeGetPr },
  models: { chat, compactor },
});

describe("bot plumbing", () => {
  it("splits long replies under Telegram's limit, preferring line breaks", () => {
    const text = `${"a".repeat(30)}\n${"b".repeat(30)}`;
    expect(splitMessage(text, 40)).toEqual(["a".repeat(30), "b".repeat(30)]);
    expect(splitMessage("short", 40)).toEqual(["short"]);
    expect(splitMessage("x".repeat(100), 40).every((p) => p.length <= 40)).toBe(true);
  });

  it("only lets the owner in, and only in a private chat", () => {
    expect(isOwner({ from: { id: 7 } as any, chat: { type: "private" } as any }, 7)).toBe(true);
    expect(isOwner({ from: { id: 8 } as any, chat: { type: "private" } as any }, 7)).toBe(false);
    expect(isOwner({ from: { id: 7 } as any, chat: { type: "group" } as any }, 7)).toBe(false);
  });

  it("explains which env var is missing", () => {
    expect(() => readBotEnv({})).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => readBotEnv({ TELEGRAM_BOT_TOKEN: "t" })).toThrow(/TELEGRAM_OWNER_ID/);
    expect(() => readBotEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_OWNER_ID: "12", TELEGRAM_WEBHOOK_URL: "https://x" })).toThrow(ConfigError);
    expect(readBotEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_OWNER_ID: "12" })).toEqual({ token: "t", ownerId: 12 });
  });
});

describe("compaction", () => {
  const convo: ModelMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "get_pr", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "get_pr", output: { type: "text", value: "r" } }] },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ];

  it("cuts at a user turn so tool calls stay with their results", () => {
    const split = splitForCompaction(convo, 1)!;
    expect(split.older).toHaveLength(4);
    expect(split.tail[0]).toEqual({ role: "user", content: "q2" });
    expect(splitForCompaction(convo, 2)).toBeUndefined();
  });

  it("carries the summary inside the first kept user turn", () => {
    const out = withSummary(splitForCompaction(convo, 1)!.tail, "S");
    expect(out[0].content).toMatch(/Summary of the earlier conversation\]\nS\n.*\n\nq2$/s);
  });
});

describe("handleOwnerMessage", () => {
  it("answers with tools, sends progress notes and keeps the session between messages", async () => {
    const chat = new MockLanguageModelV4({
      doGenerate: [call("send_message", { text: "Mirando el PR…" }), call("get_pr", { number: 16 }), answer("El #16 suma la TUP."), answer("De nada")],
    });
    const d = deps(harness(), chat);
    const sent: string[] = [];
    const send = async (t: string) => void sent.push(t);

    expect(await handleOwnerMessage("42", "¿Qué hizo el PR 16?", send, d)).toBe("El #16 suma la TUP.");
    expect(sent).toEqual(["Mirando el PR…"]);

    await handleOwnerMessage("42", "gracias", send, d);
    // The second call carries the first exchange, including the tool result.
    const secondPrompt = JSON.stringify(chat.doGenerateCalls[3].prompt);
    expect(secondPrompt).toContain("adds TUP support");
    expect(secondPrompt).toContain("gracias");

    const transcript = d.db.prepare("SELECT author, text FROM chat_transcript ORDER BY id").all() as { author: string; text: string }[];
    expect(transcript.map((t) => t.author)).toEqual(["owner", "bot", "bot", "owner", "bot"]);
    expect(statusSummary(d.db)).toMatch(/All time: 2 runs/);
  });

  it("starts over when the chat's instructions or tools changed since the session was saved", async () => {
    const chat = new MockLanguageModelV4({ doGenerate: [answer("uno"), answer("dos")] });
    const d = deps(harness(), chat);
    await handleOwnerMessage("42", "primero", async () => {}, d);
    const changed = { ...d, harness: { ...d.harness, roles: { ...d.harness.roles, chat: { ...role(["get_pr", "send_message"]), maxSteps: 6 } } } };
    const sent: string[] = [];
    await handleOwnerMessage("42", "segundo", async (t) => void sent.push(t), changed);
    expect(JSON.stringify(chat.doGenerateCalls[1].prompt)).not.toContain("primero");
    expect(sent[0]).toMatch(/fresh conversation/);
  });

  it("drafts through the pipeline when the owner asks for a post", async () => {
    const chat = new MockLanguageModelV4({ doGenerate: [call("draft_for_pr", { pr: 17 }), answer("Te mandé el draft del #17.")] });
    const asked: unknown[] = [];
    const d = { ...deps(harness(), chat), draftPr: async (pr: number, format?: string) => (asked.push([pr, format]), "a post draft card was sent to the owner") };
    d.harness.roles.chat = role(["get_pr", "send_message", "draft_for_pr"]);
    expect(await handleOwnerMessage("42", "armá un post del 17", async () => {}, d)).toBe("Te mandé el draft del #17.");
    expect(asked).toEqual([[17, undefined]]);
  });

  it("forgets the conversation after /new", async () => {
    const chat = new MockLanguageModelV4({ doGenerate: [answer("uno"), answer("dos")] });
    const d = deps(harness(), chat);
    await handleOwnerMessage("42", "primero", async () => {}, d);
    resetSession(d.db, "42");
    await handleOwnerMessage("42", "segundo", async () => {}, d);
    expect(JSON.stringify(chat.doGenerateCalls[1].prompt)).not.toContain("primero");
  });

  it("summarizes old turns once the session is too long", async () => {
    const chat = new MockLanguageModelV4({ doGenerate: [answer("r1"), answer("r2"), answer("r3")] });
    const compactor = new MockLanguageModelV4({ doGenerate: [answer("- the owner asked about PR 16")] });
    const d = deps(harness(50), chat, compactor);
    await handleOwnerMessage("42", "first question", async () => {}, d);
    await handleOwnerMessage("42", "second question", async () => {}, d);

    expect(compactor.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(compactor.doGenerateCalls[0].prompt)).toContain("first question");
    const prompt = JSON.stringify(chat.doGenerateCalls[1].prompt);
    expect(prompt).toContain("the owner asked about PR 16");
    expect(prompt).not.toContain("first question");
  });
});
