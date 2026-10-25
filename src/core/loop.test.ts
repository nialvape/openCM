import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runAgent, type AgentTool } from "./loop.js";
import { openDb } from "../store/db.js";
import type { HarnessConfig } from "./config.js";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const toolCall = (id: string, input: object) => ({
  content: [{ type: "tool-call" as const, toolCallId: id, toolName: "lookup", input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
  usage,
  warnings: [],
});

const answer = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "end_turn" },
  usage,
  warnings: [],
});

const harness = (overrides: Partial<HarnessConfig["roles"][string]> = {}): HarnessConfig => ({
  roles: { tester: { model: "mock:m", tools: ["lookup"], maxSteps: 5, maxCostUsd: 1, plan: false, ...overrides } },
  maxToolOutputChars: 1000,
  pricing: { "mock:m": { input: 1_000, output: 1_000 } }, // $0.11 per step with the usage above
});

const lookup: AgentTool<{ q: string }> = {
  description: "test lookup",
  inputSchema: z.object({ q: z.string() }),
  execute: async ({ q }) => (q === "boom" ? Promise.reject(new Error("exploded")) : `result for ${q} with ghp_${"a".repeat(36)}`),
};

describe("runAgent", () => {
  it("runs tools, checkpoints every step and stops on a plain answer", async () => {
    const db = openDb(":memory:");
    const model = new MockLanguageModelV4({ doGenerate: [toolCall("c1", { q: "x" }), answer("final")] });
    const result = await runAgent({ role: "tester", task: "do it", tools: { lookup }, harness: harness(), model, db });

    expect(result.status).toBe("done");
    expect(result.text).toBe("final");
    expect(result.steps).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.22);
    const checkpoints = db.prepare("SELECT step FROM checkpoints WHERE run_id = ? ORDER BY step").all(result.runId);
    expect(checkpoints.map((c: any) => c.step)).toEqual([1, 2]);

    // The tool result the model saw was scrubbed of the token.
    const secondCall = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(secondCall).toContain("result for x");
    expect(secondCall).not.toContain("ghp_aaaa");
  });

  it("turns tool errors into text the model can act on", async () => {
    const db = openDb(":memory:");
    const model = new MockLanguageModelV4({ doGenerate: [toolCall("c1", { q: "boom" }), answer("ok")] });
    await runAgent({ role: "tester", task: "t", tools: { lookup }, harness: harness(), model, db });
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("Error from lookup: exploded");
  });

  it("forces an answer on the last allowed step instead of another tool call", async () => {
    const db = openDb(":memory:");
    const model = new MockLanguageModelV4({ doGenerate: [toolCall("c1", { q: "a" }), answer("con lo que tengo")] });
    const result = await runAgent({ role: "tester", task: "t", tools: { lookup }, harness: harness({ maxSteps: 2 }), model, db });
    expect(result).toMatchObject({ status: "done", text: "con lo que tengo" });
    expect(model.doGenerateCalls[0].toolChoice).toEqual({ type: "auto" });
    expect(model.doGenerateCalls[1].toolChoice).toEqual({ type: "none" });
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("You have no tool calls left");
  });

  it("stops at the step budget", async () => {
    const db = openDb(":memory:");
    const model = new MockLanguageModelV4({ doGenerate: [toolCall("c1", { q: "a" }), toolCall("c2", { q: "b" })] });
    const result = await runAgent({ role: "tester", task: "t", tools: { lookup }, harness: harness({ maxSteps: 2 }), model, db });
    expect(result.status).toBe("max_steps");
    expect(result.steps).toBe(2);
  });

  it("stops at the cost budget", async () => {
    const db = openDb(":memory:");
    const model = new MockLanguageModelV4({ doGenerate: [toolCall("c1", { q: "a" }), toolCall("c2", { q: "b" }), answer("x")] });
    const result = await runAgent({ role: "tester", task: "t", tools: { lookup }, harness: harness({ maxCostUsd: 0.15 }), model, db });
    expect(result.status).toBe("budget");
    expect(result.steps).toBe(2);
  });

  it("resumes from the last checkpoint with the conversation so far", async () => {
    const db = openDb(":memory:");
    // Step 1 succeeds, then the provider fails (a crash or a lost connection mid-run).
    let calls = 0;
    const flaky = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        if (calls === 1) return toolCall("c1", { q: "a" });
        throw new Error("connection reset");
      },
    });
    const interrupted = await runAgent({ role: "tester", task: "t", tools: { lookup }, harness: harness(), model: flaky, db });
    expect(interrupted.status).toBe("error");
    expect(interrupted.steps).toBe(1);

    const second = new MockLanguageModelV4({ doGenerate: [answer("finished")] });
    const resumed = await runAgent({ role: "tester", task: "", tools: { lookup }, harness: harness(), model: second, db, resumeRunId: interrupted.runId });

    expect(resumed.status).toBe("done");
    expect(resumed.text).toBe("finished");
    expect(resumed.steps).toBe(2);
    expect(resumed.costUsd).toBeCloseTo(0.22);
    // The resumed call carries the original task and the step-1 tool result; no tool ran twice.
    const prompt = JSON.stringify(second.doGenerateCalls[0].prompt);
    expect(prompt).toContain("result for a");
    expect(second.doGenerateCalls).toHaveLength(1);
  });

  it("refuses to resume a run made with a different harness version", async () => {
    const db = openDb(":memory:");
    const model = new MockLanguageModelV4({ doGenerate: [toolCall("c1", { q: "a" })] });
    const run = await runAgent({ role: "tester", task: "t", tools: { lookup }, harness: harness({ maxSteps: 1 }), model, db });
    await expect(
      runAgent({ role: "tester", task: "", tools: { lookup }, harness: harness({ maxSteps: 3 }), model, db, resumeRunId: run.runId }),
    ).rejects.toThrow(/harness/);
  });

  it("never gives the model a tool the role does not list", async () => {
    const db = openDb(":memory:");
    const model = new MockLanguageModelV4({ doGenerate: [answer("x")] });
    await runAgent({ role: "tester", task: "t", tools: { lookup, secret: lookup }, harness: harness(), model, db });
    const offered = (model.doGenerateCalls[0].tools ?? []).map((t: any) => t.name);
    expect(offered).toEqual(["lookup"]);
  });
});
