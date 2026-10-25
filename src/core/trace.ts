import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";

export type TraceEvent =
  | { type: "run_start"; role: string; model: string; harnessVersion: string; task: string }
  | { type: "step"; step: number; finishReason: string; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cachedTokens?: number; costUsd?: number }
  | { type: "tool_call"; step: number; tool: string; input: unknown }
  | { type: "tool_result"; step: number; tool: string; chars: number; truncated: boolean; error?: string }
  | { type: "tool_blocked"; step: number; tool: string; reason: string }
  | { type: "run_end"; status: RunStatus; steps: number; costUsd?: number; error?: string };

/** "length": the last call hit maxOutputTokens, so the answer is cut or missing. */
export type RunStatus = "done" | "length" | "max_steps" | "budget" | "error";

/** One JSONL file per run in data/traces/. Append-only, so a crash leaves a readable partial trace. */
export class Trace {
  readonly file: string;

  constructor(readonly runId: string, dir = paths.traces) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${runId}.jsonl`);
  }

  write(event: TraceEvent): void {
    appendFileSync(this.file, JSON.stringify({ t: new Date().toISOString(), runId: this.runId, ...event }) + "\n");
  }
}
