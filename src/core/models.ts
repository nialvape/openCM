import { createGateway, type Experimental_DecisionModel, type LanguageModel, type LanguageModelUsage, type ProviderMetadata } from "ai";

type GatewayProvider = ReturnType<typeof createGateway>;
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { ConfigError, type HarnessConfig } from "./config.js";

let gatewayProvider: GatewayProvider | undefined;
/** Created on first use: the key comes from .env, which the CLI loads after this module is imported. */
function vercelGateway(): GatewayProvider {
  gatewayProvider ??= createGateway({ apiKey: process.env.VERCEL_AI_GATEWAY_API_KEY ?? process.env.AI_GATEWAY_API_KEY });
  return gatewayProvider;
}

/** Providers are looked up by the prefix of "<provider>:<model>". Adding one is one line here. */
const providers: Record<string, (modelId: string) => LanguageModel> = {
  // Vercel AI Gateway ids are "<vendor>/<model>" too, e.g. gateway:zai/glm-5.3.
  gateway: (id) => vercelGateway()(id),
  // OpenRouter ids are "<vendor>/<model>", e.g. openrouter:anthropic/claude-sonnet-5.5.
  // Usage accounting makes OpenRouter report the real cost of each call.
  openrouter: (id) => openrouter(id, { usage: { include: true } }),
  anthropic: (id) => anthropic(id),
  openai: (id) => openai(id),
  google: (id) => google(id),
};

export function splitModelRef(ref: string): { provider: string; modelId: string } {
  const i = ref.indexOf(":");
  if (i <= 0) throw new ConfigError(`Model '${ref}' must be '<provider>:<model>'`);
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

export function resolveModel(ref: string): LanguageModel {
  const { provider, modelId } = splitModelRef(ref);
  const make = providers[provider];
  if (!make) throw new ConfigError(`Unknown provider '${provider}' in '${ref}'. Known: ${Object.keys(providers).join(", ")}`);
  return make(modelId);
}

/** Decision models (typed answers with probabilities): Vercel AI Gateway and OpenRouter's Decisions API. */
const decisionProviders: Record<string, (modelId: string) => Experimental_DecisionModel> = {
  // The gateway implements ai@7's decision contract natively, so it needs no adapter.
  gateway: (id) => vercelGateway().decisionModel(id),
  openrouter: (id) => fromEvaluationModel(openrouter.evaluationModel(id)),
};

type StatePart = { type: "text"; text: string } | { type: "json"; value: unknown } | { type: string };

/**
 * @openrouter/ai-sdk-provider 3.1 still implements the older "evaluation model" contract, which
 * takes the state as plain text/JSON, while ai@7 now hands models the state as typed parts. This
 * adapter turns the parts back into what OpenRouter's Decisions API expects.
 */
function fromEvaluationModel(model: ReturnType<typeof openrouter.evaluationModel>): Experimental_DecisionModel {
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    supportedQuestionTypes: model.supportedQuestionTypes,
    doDecide: (options: any) => model.doEvaluate({ ...options, state: plainState(options.state) }),
  } as unknown as Experimental_DecisionModel;
}

export function plainState(parts: readonly StatePart[]): any {
  const values = parts.map((p) => {
    if (p.type === "text") return (p as { text: string }).text;
    if (p.type === "json") return (p as { value: unknown }).value;
    throw new ConfigError(`Decision state part '${p.type}' is not supported by OpenRouter decision models; send text or JSON`);
  });
  return values.length === 1 ? values[0] : values;
}

export function resolveDecisionModel(ref: string): Experimental_DecisionModel {
  const { provider, modelId } = splitModelRef(ref);
  const make = decisionProviders[provider];
  if (!make) throw new ConfigError(`No decision models for provider '${provider}' in '${ref}'. Known: ${Object.keys(decisionProviders).join(", ")}`);
  return make(modelId);
}

/**
 * Model family (the vendor that trained it), used to keep the critic on a different family than
 * the writer. Through a router the family is the vendor in the id, not the router.
 */
export function modelFamily(ref: string): string {
  const { provider, modelId } = splitModelRef(ref);
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : provider;
}

/**
 * USD for one call. A price in config wins (lets you override or price direct providers);
 * otherwise the cost the provider reported (OpenRouter does); otherwise undefined.
 */
export function costUsd(config: HarnessConfig, ref: string, usage: LanguageModelUsage, metadata?: ProviderMetadata): number | undefined {
  const price = config.pricing[ref];
  if (price) {
    const cached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
    const input = (usage.inputTokens ?? 0) - cached;
    const output = usage.outputTokens ?? 0;
    const perToken = 1 / 1_000_000;
    return (input * price.input + cached * (price.cacheRead ?? price.input) + output * price.output) * perToken;
  }
  return reportedCost(metadata);
}

function reportedCost(metadata?: ProviderMetadata): number | undefined {
  // The gateway records cost asynchronously; use it when it does come inline, else config pricing applies.
  const gatewayCost = (metadata?.gateway as Record<string, unknown> | undefined)?.cost;
  if (typeof gatewayCost === "number") return gatewayCost;
  const usage = metadata?.openrouter?.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined;
  const cost = (usage as Record<string, unknown>).cost;
  return typeof cost === "number" ? cost : undefined;
}
