import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { experimental_decide, type Experimental_DecisionModel, type Experimental_DecisionQuestion } from "ai";
import { parse } from "yaml";
import { z } from "zod";
import { ConfigError, type DecisionsConfig } from "./config.js";
import { resolveDecisionModel } from "./models.js";
import { paths } from "./paths.js";
import { db as sharedDb, now } from "../store/db.js";

const Text = z.string().min(1);
const QuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), instructions: Text.optional(), criteria: z.record(z.string(), Text.nullable()) }),
  z.object({ type: z.literal("boolean"), instructions: Text, criteria: z.object({ true: Text.nullable().optional(), false: Text.nullable().optional() }).optional() }),
  z.object({ type: z.literal("score"), instructions: Text.optional(), criteria: z.array(Text.nullable()).min(2) }),
]);
const DecisionSchemaFile = z.object({ questions: z.record(z.string(), QuestionSchema) });

export interface DecisionSchema {
  name: string;
  questions: Record<string, Experimental_DecisionQuestion>;
  /** Hash of the questions: a reworded question is a different decision and gets fresh labels. */
  version: string;
  source: "core" | "project";
}

/** decisions/<name>.yaml, or the project's projects/<id>/decisions/<name>.yaml, which replaces it whole. */
export function loadDecisionSchema(name: string, projectId?: string, roots = { core: paths.decisions, project: projectId ? join(paths.projectDir(projectId), "decisions") : undefined }): DecisionSchema {
  const projectFile = roots.project ? join(roots.project, `${name}.yaml`) : undefined;
  const source = projectFile && existsSync(projectFile) ? "project" : "core";
  const file = source === "project" ? projectFile! : join(roots.core, `${name}.yaml`);
  if (!existsSync(file)) throw new ConfigError(`No decision schema '${name}'. Create decisions/${name}.yaml`);
  const parsed = DecisionSchemaFile.safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new ConfigError(`Invalid decision schema ${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const questions = parsed.data.questions as Record<string, Experimental_DecisionQuestion>;
  const version = createHash("sha256").update(JSON.stringify(questions)).digest("hex").slice(0, 12);
  return { name, questions, version, source };
}

export type GatedAnswer =
  | { type: "choice"; value: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: "boolean"; value: boolean; confidence: number; probability: number }
  | { type: "score"; value: number; confidence?: number; probabilities?: Record<string, number> }
  | { type: "refusal" };

export interface GatedDecision {
  id: string;
  answers: Record<string, GatedAnswer>;
  /** Questions whose answer is below its threshold (or refused): the owner answers these. */
  needsOwner: string[];
  schemaVersion: string;
  model: string;
}

/**
 * How sure the model is of the answer it gave. Choice/score: probability of the chosen option.
 * Boolean: probability of the side it leans to. Undefined when the provider gave no distribution.
 */
export function confidenceOf(answer: GatedAnswer): number | undefined {
  return answer.type === "refusal" ? 0 : answer.confidence;
}

export function thresholdFor(config: DecisionsConfig, schema: string, question: string): number {
  return config.thresholds[`${schema}.${question}`] ?? config.thresholds[question] ?? config.thresholds.default!;
}

function toGated(answer: any): GatedAnswer {
  switch (answer.type) {
    case "choice":
      return { type: "choice", value: answer.choice, probabilities: answer.probabilities, confidence: answer.probabilities?.[answer.choice] };
    case "boolean":
      return { type: "boolean", value: answer.probability >= 0.5, probability: answer.probability, confidence: Math.max(answer.probability, 1 - answer.probability) };
    case "score": {
      const top = answer.probabilities ? Math.max(...Object.values(answer.probabilities as Record<string, number>)) : undefined;
      return { type: "score", value: answer.score, probabilities: answer.probabilities, confidence: top };
    }
    default:
      return { type: "refusal" };
  }
}

export interface DecideOptions {
  schema: DecisionSchema;
  /** The situation to judge. Untrusted repo text inside it should be fenced (asUntrustedData). */
  state: string | Record<string, unknown>;
  config: DecisionsConfig;
  projectId?: string;
  /** What is being decided about, for later lookup (e.g. "pr#16"). */
  subject?: string;
  model?: Experimental_DecisionModel;
  db?: DatabaseSync;
}

/**
 * Asks the decision model every question of a schema and applies the confidence gate: answers
 * below their threshold go to the owner. Every call is stored, and the owner's answers are later
 * stored next to it, which is the labeled data used to refit thresholds and to evaluate models.
 */
export async function decideGated(opts: DecideOptions): Promise<GatedDecision> {
  const store = opts.db ?? sharedDb();
  const model = opts.model ?? resolveDecisionModel(opts.config.model);
  const result = await experimental_decide({ model, state: opts.state as any, questions: opts.schema.questions });

  const answers: Record<string, GatedAnswer> = {};
  const needsOwner: string[] = [];
  for (const id of Object.keys(opts.schema.questions)) {
    const answer = toGated((result.answers as Record<string, unknown>)[id]);
    answers[id] = answer;
    const confidence = confidenceOf(answer);
    if (confidence === undefined || confidence < thresholdFor(opts.config, opts.schema.name, id)) needsOwner.push(id);
  }

  const id = randomUUID();
  store
    .prepare("INSERT INTO decisions (id, project, schema, schema_version, model, subject, state, answers, needs_owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, opts.projectId ?? null, opts.schema.name, opts.schema.version, opts.config.model, opts.subject ?? null, JSON.stringify(opts.state), JSON.stringify(answers), JSON.stringify(needsOwner), now());
  return { id, answers, needsOwner, schemaVersion: opts.schema.version, model: opts.config.model };
}

/** Stores what the owner chose (or confirmed). Overrides of confident answers are labels too. */
export function recordOwnerAnswers(id: string, ownerAnswers: Record<string, string | boolean | number>, store: DatabaseSync = sharedDb()): void {
  const res = store.prepare("UPDATE decisions SET owner_answers = ?, decided_at = ? WHERE id = ?").run(JSON.stringify(ownerAnswers), now(), id);
  if (res.changes === 0) throw new Error(`Decision ${id} not found`);
}

export interface LabeledAnswer {
  confidence: number;
  correct: boolean;
}

/**
 * Lowest threshold at which the answers the model would have decided alone reach `targetAccuracy`.
 * Returns undefined when there isn't enough labeled data to trust a fit.
 */
export function fitThreshold(labeled: LabeledAnswer[], targetAccuracy = 0.95, minSamples = 20): number | undefined {
  if (labeled.length < minSamples) return undefined;
  const candidates = [...new Set(labeled.map((l) => l.confidence))].sort((a, b) => a - b);
  for (const t of candidates) {
    const accepted = labeled.filter((l) => l.confidence >= t);
    if (accepted.length < minSamples / 2) break;
    const accuracy = accepted.filter((l) => l.correct).length / accepted.length;
    if (accuracy >= targetAccuracy) return t;
  }
  return undefined;
}
