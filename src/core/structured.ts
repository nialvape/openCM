import { z } from "zod";
import { runAgent, type RunOptions, type RunResult } from "./loop.js";

export class StructuredOutputError extends Error {
  name = "StructuredOutputError";
}

/** Pulls a JSON value out of a model answer: a ```json fence if there is one, else the outermost braces. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate.trim()) throw new StructuredOutputError("The answer contains no JSON object");
  return JSON.parse(candidate);
}

function validate<T>(schema: z.ZodType<T>, text: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    const parsed = schema.safeParse(extractJson(text));
    if (parsed.success) return { ok: true, value: parsed.data };
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Runs an agent whose final answer must be JSON matching `schema`. A wrong answer gets one more
 * turn in the same conversation, with the validation error, before giving up. Works with any model:
 * it doesn't depend on a provider's structured-output mode.
 */
export async function runAgentJson<T>(schema: z.ZodType<T>, opts: RunOptions, retries = 1): Promise<{ value: T; runs: RunResult[] }> {
  const runs: RunResult[] = [];
  let result = await runAgent(opts);
  runs.push(result);
  for (let attempt = 0; ; attempt++) {
    if (result.status === "length" && attempt < retries) {
      // Ran out of output budget, usually while reasoning. Start over (the partial thinking would only
      // fill the context) with reasoning off and a reminder to answer directly.
      result = await runAgent({
        ...opts,
        resumeRunId: undefined,
        reasoning: "none",
        task: `${opts.task}\n\nAnswer directly with the JSON. Don't draft or count in your reasoning; use the tools for measuring.`,
      });
      runs.push(result);
      continue;
    }
    if (result.status !== "done") throw new StructuredOutputError(`${opts.role} stopped with status '${result.status}' (run ${result.runId})`);
    const checked = validate(schema, result.text);
    if (checked.ok) return { value: checked.value, runs };
    if (attempt >= retries) throw new StructuredOutputError(`${opts.role} returned invalid JSON (run ${result.runId}): ${checked.error}`);
    result = await runAgent({
      ...opts,
      resumeRunId: undefined,
      history: result.messages,
      task: `Your answer was not valid: ${checked.error}\nReply again with only the corrected JSON.`,
    });
    runs.push(result);
  }
}
