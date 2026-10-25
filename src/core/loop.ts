import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { APICallError, generateText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { roleConfig, type HarnessConfig, type ReasoningEffort } from "./config.js";
import { assemblePrompt, loadSections, type SectionName } from "./context.js";
import { costUsd, resolveModel } from "./models.js";
import { allowedTools, limitOutput, scrubSecrets } from "./policy.js";
import { discoverSkills, skillBodies, skillsIndex, type Skill } from "./skills.js";
import { Trace, type RunStatus } from "./trace.js";
import { db as sharedDb, now } from "../store/db.js";

/** A tool as the harness sees it. Tools return text (or JSON); the loop scrubs, limits and traces it. */
export interface AgentTool<I = any> {
  description: string;
  inputSchema: z.ZodType<I>;
  execute: (input: I) => Promise<unknown>;
}

export interface RunOptions {
  role: string;
  projectId?: string;
  /** The user message: everything that varies per task. Untrusted repo text must already be fenced (asUntrustedData). */
  task: string;
  /** Tools registered for this run; the role's allowlist in config picks which ones the model gets. */
  tools?: Record<string, AgentTool>;
  harness: HarnessConfig;
  /** Extra prompt sections, e.g. `environment`. */
  sections?: Partial<Record<SectionName, string>>;
  /** Earlier turns of a conversation (chat sessions); the task is appended as the newest user message. */
  history?: ModelMessage[];
  /** Overrides the role's reasoning effort for this run, e.g. to retry a call that ran out while thinking. */
  reasoning?: ReasoningEffort;
  /** Resume this run from its last checkpoint instead of starting a new one. */
  resumeRunId?: string;
  /** Injected for tests and evals; otherwise resolved from the role's config. */
  model?: LanguageModel;
  db?: DatabaseSync;
  skillRoots?: { core: string; project?: string };
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  text: string;
  steps: number;
  costUsd?: number;
  harnessVersion: string;
  /** The whole conversation after the run, history included: what a chat session keeps. */
  messages: ModelMessage[];
  /** Why the run failed, when status is "error". */
  error?: string;
}

const LAST_STEP_NOTE = "You have no tool calls left. Give your final answer now, in the requested format, with what you already know.";

const PLAN_NOTE = "\n\nBefore using any tool, write a short numbered plan. Then follow it, adjusting if you learn something new.";

/**
 * The agent loop. One generateText call is one step (the model answers or calls tools; the tools
 * run). After every step the whole conversation is checkpointed, so a run interrupted by a crash
 * or a shutdown resumes from the last finished step. Stops when the model answers without calling
 * tools, or when the step or cost budget from config runs out.
 */
export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const store = opts.db ?? sharedDb();
  const rc = roleConfig(opts.harness, opts.role);
  const model = opts.model ?? resolveModel(rc.model);

  const skills = discoverSkills(opts.projectId, opts.skillRoots);
  const wantsSkills = rc.tools.includes("load_skill");
  const prompt = assemblePrompt(
    { ...loadSections(opts.role, opts.projectId), ...(wantsSkills ? { skills: skillsIndex(skills) } : {}), ...opts.sections },
    rc,
    wantsSkills ? skillBodies(skills) : [],
  );

  let runId: string;
  let messages: ModelMessage[];
  let step: number;
  let spent: number | undefined;

  if (opts.resumeRunId) {
    runId = opts.resumeRunId;
    const run = store.prepare("SELECT harness_version, cost_usd FROM runs WHERE id = ?").get(runId) as
      | { harness_version: string; cost_usd: number | null }
      | undefined;
    if (!run) throw new Error(`Run ${runId} not found; start a new run instead`);
    if (run.harness_version !== prompt.harnessVersion) {
      throw new Error(`Run ${runId} used harness ${run.harness_version}, current is ${prompt.harnessVersion}; prompts or config changed, start a new run`);
    }
    const cp = store.prepare("SELECT step, messages FROM checkpoints WHERE run_id = ? ORDER BY step DESC LIMIT 1").get(runId) as
      | { step: number; messages: string }
      | undefined;
    step = cp?.step ?? 0;
    messages = cp ? JSON.parse(cp.messages) : [{ role: "user", content: opts.task }];
    spent = run.cost_usd ?? undefined;
  } else {
    runId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${opts.role}_${randomUUID().slice(0, 8)}`;
    step = 0;
    messages = [...(opts.history ?? []), { role: "user", content: rc.plan ? opts.task + PLAN_NOTE : opts.task }];
    store
      .prepare("INSERT INTO runs (id, project, role, model, harness_version, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)")
      .run(runId, opts.projectId ?? null, opts.role, rc.model, prompt.harnessVersion, opts.task, now(), now());
  }

  const trace = new Trace(runId);
  trace.write({ type: "run_start", role: opts.role, model: rc.model, harnessVersion: prompt.harnessVersion, task: opts.task.slice(0, 500) });

  const available: Record<string, AgentTool> = { ...opts.tools, ...(wantsSkills ? { load_skill: loadSkillTool(skills, (s) => logSkill(s)) } : {}) };
  const granted = allowedTools(opts.role, rc, available);
  let currentStep = step;
  const logSkill = (s: Skill) =>
    store.prepare("INSERT INTO skill_usage (run_id, skill, source, step) VALUES (?, ?, ?, ?)").run(runId, s.name, s.source, currentStep + 1);
  const tools = wrapTools(granted, opts.harness.maxToolOutputChars, trace, () => currentStep + 1);

  let status: RunStatus = "max_steps";
  let text = "";
  let error: string | undefined;

  try {
    while (step < rc.maxSteps) {
      currentStep = step;
      // The last allowed step must produce an answer: a run that ends mid-research is wasted spend.
      const lastStep = rc.maxSteps > 1 && step === rc.maxSteps - 1 && Object.keys(tools).length > 0;
      if (lastStep) messages = [...messages, { role: "user", content: LAST_STEP_NOTE }];
      const result = await withRetries(
        () =>
          generateText({
            model,
            instructions: prompt.instructions,
            messages,
            tools,
            ...(lastStep ? { toolChoice: "none" as const } : {}),
            maxOutputTokens: rc.maxOutputTokens,
            timeout: rc.stepTimeoutSec ? { stepMs: rc.stepTimeoutSec * 1000 } : undefined,
            reasoning: opts.reasoning ?? rc.reasoning,
            maxRetries: 0,
          }),
        (attempt, info) => trace.write({ type: "model_error", step: step + 1, attempt, ...info }),
      );
      step++;
      messages = [...messages, ...result.responseMessages];

      const cost = costUsd(opts.harness, rc.model, result.usage, result.providerMetadata);
      if (cost !== undefined) spent = (spent ?? 0) + cost;
      trace.write({
        type: "step",
        step,
        finishReason: result.finishReason,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens,
        cachedTokens: result.usage.inputTokenDetails?.cacheReadTokens,
        costUsd: cost,
      });
      store
        .prepare("INSERT INTO checkpoints (run_id, step, messages, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(runId, step, JSON.stringify(messages), spent ?? null, now());
      store.prepare("UPDATE runs SET steps = ?, cost_usd = ?, updated_at = ? WHERE id = ?").run(step, spent ?? null, now(), runId);

      if (result.finishReason !== "tool-calls") {
        status = result.finishReason === "length" ? "length" : "done";
        text = result.text;
        break;
      }
      if (spent !== undefined && spent > rc.maxCostUsd) {
        status = "budget";
        break;
      }
    }
  } catch (e) {
    status = "error";
    error = describeModelError(e).summary;
  }

  store
    .prepare("UPDATE runs SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?")
    .run(status, text || null, error ?? null, now(), runId);
  trace.write({ type: "run_end", status, steps: step, costUsd: spent, error });
  return { runId, status, text, steps: step, costUsd: spent, harnessVersion: prompt.harnessVersion, messages, error };
}

/** Attempts per step for a failed model call, and the longest wait between them. */
export const MODEL_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 30_000;

export interface ModelErrorInfo {
  name: string;
  message: string;
  statusCode?: number;
  retryable: boolean;
  retryAfterMs?: number;
  body?: string;
  /** One line for the run's error column and the owner. */
  summary: string;
}

/** What a failed model call says about itself: the SDK's retries used to hide the real cause. */
export function describeModelError(e: unknown): ModelErrorInfo {
  const err = e instanceof Error ? e : new Error(String(e));
  const api = APICallError.isInstance(err) ? err : APICallError.isInstance(err.cause) ? err.cause : undefined;
  const headers = api?.responseHeaders ?? {};
  const after = headers["retry-after-ms"] ? Number(headers["retry-after-ms"]) : headers["retry-after"] ? Number(headers["retry-after"]) * 1000 : undefined;
  // A step that hit its timeout may just have hit a slow moment of the provider; worth one more try.
  const timedOut = err.name === "TimeoutError" || err.name === "AbortError" || /aborted|timed? ?out/i.test(err.message);
  const body = api?.responseBody ? scrubSecrets(api.responseBody).slice(0, 500) : undefined;
  return {
    name: err.name,
    message: scrubSecrets(err.message),
    statusCode: api?.statusCode,
    retryable: api ? api.isRetryable : timedOut,
    retryAfterMs: after !== undefined && Number.isFinite(after) ? after : undefined,
    body,
    summary: scrubSecrets(`${api?.statusCode ? `HTTP ${api.statusCode}: ` : ""}${err.message}${body ? ` — ${body.slice(0, 200)}` : ""}`),
  };
}

/**
 * Runs one model call with its own retries, so each attempt gets the full step timeout (the SDK's
 * retries shared it, and a slow failure left none) and every failure is traced with its cause.
 */
export async function withRetries<T>(call: () => Promise<T>, onError: (attempt: number, info: ModelErrorInfo) => void, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      const info = describeModelError(e);
      onError(attempt, info);
      if (!info.retryable || attempt >= MODEL_ATTEMPTS) throw e;
      await wait(Math.min(info.retryAfterMs ?? 2000 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS));
    }
  }
}

/** Wraps harness tools as AI SDK tools: errors become text the model can act on; output is scrubbed and limited. */
function wrapTools(tools: Record<string, AgentTool>, maxChars: number, trace: Trace, stepNo: () => number): ToolSet {
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    out[name] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: async (input: unknown) => {
        trace.write({ type: "tool_call", step: stepNo(), tool: name, input });
        try {
          const raw = await t.execute(input);
          const textOut = typeof raw === "string" ? raw : JSON.stringify(raw);
          const limited = limitOutput(scrubSecrets(textOut), maxChars);
          trace.write({ type: "tool_result", step: stepNo(), tool: name, chars: textOut.length, truncated: limited.truncated });
          return limited.text;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          trace.write({ type: "tool_result", step: stepNo(), tool: name, chars: 0, truncated: false, error: message });
          return `Error from ${name}: ${scrubSecrets(message)}`;
        }
      },
    });
  }
  return out;
}

function loadSkillTool(skills: Map<string, Skill>, onLoad: (s: Skill) => void): AgentTool<{ name: string }> {
  return {
    description: "Loads the full instructions of a skill listed in <skills>. Call it before doing the kind of work the skill covers.",
    inputSchema: z.object({ name: z.string().describe("Skill name exactly as listed, e.g. 'x-thread'") }),
    execute: async ({ name }) => {
      const skill = skills.get(name);
      if (!skill) return `No skill named '${name}'. Available: ${[...skills.keys()].join(", ") || "none"}`;
      onLoad(skill);
      return skill.body;
    },
  };
}
