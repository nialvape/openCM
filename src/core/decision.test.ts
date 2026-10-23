import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Experimental_DecisionMockModelV4 as DecisionMock } from "ai/test";
import { decideGated, fitThreshold, loadDecisionSchema, recordOwnerAnswers, thresholdFor } from "./decision.js";
import { ConfigError } from "./config.js";
import { plainState } from "./models.js";
import { openDb } from "../store/db.js";

const SCHEMA = `questions:
  format:
    type: choice
    instructions: How much content?
    criteria: { skip: internal, post: one post, thread: a thread }
  link_worth_cost:
    type: boolean
    instructions: Needs a link?
`;

function schemaRoots(project?: string) {
  const root = mkdtempSync(join(tmpdir(), "opencm-decisions-"));
  mkdirSync(join(root, "core"));
  writeFileSync(join(root, "core", "content-format.yaml"), SCHEMA);
  if (project) {
    mkdirSync(join(root, "project"));
    writeFileSync(join(root, "project", "content-format.yaml"), project);
  }
  return { core: join(root, "core"), project: project ? join(root, "project") : undefined };
}

const config = { model: "openrouter:cloudflare/clef-flash", thresholds: { default: 0.8, link_worth_cost: 0.6 } };

const mock = (answers: Record<string, unknown>) =>
  new DecisionMock({ doDecide: async () => ({ answers: answers as any, warnings: [] }) });

describe("decision schemas", () => {
  it("loads the core schema and lets a project replace it", () => {
    const core = loadDecisionSchema("content-format", undefined, schemaRoots());
    expect(core.source).toBe("core");
    expect(Object.keys(core.questions)).toEqual(["format", "link_worth_cost"]);

    const replaced = loadDecisionSchema("content-format", "p", schemaRoots(SCHEMA.replace("How much content?", "Cuánto contenido?")));
    expect(replaced.source).toBe("project");
    expect(replaced.version).not.toBe(core.version);
  });

  it("rejects an invalid schema with the offending path", () => {
    const roots = schemaRoots("questions:\n  format:\n    type: choice\n");
    expect(() => loadDecisionSchema("content-format", "p", roots)).toThrow(ConfigError);
  });

  it("uses the most specific threshold", () => {
    expect(thresholdFor(config, "content-format", "format")).toBe(0.8);
    expect(thresholdFor(config, "content-format", "link_worth_cost")).toBe(0.6);
    expect(thresholdFor({ ...config, thresholds: { ...config.thresholds, "content-format.format": 0.9 } }, "content-format", "format")).toBe(0.9);
  });
});

describe("decideGated", () => {
  const schema = loadDecisionSchema("content-format", undefined, schemaRoots());

  it("keeps confident answers and sends unsure ones to the owner", async () => {
    const db = openDb(":memory:");
    const model = mock({
      format: { type: "choice", choice: "post", probabilities: { skip: 0.05, post: 0.6, thread: 0.35 } },
      link_worth_cost: { type: "boolean", probability: 0.1 },
    });
    const d = await decideGated({ schema, state: { brief: "x" }, config, model, db, subject: "pr#16" });

    expect(d.answers.format).toMatchObject({ type: "choice", value: "post", confidence: 0.6 });
    expect(d.answers.link_worth_cost).toMatchObject({ type: "boolean", value: false, confidence: 0.9 });
    expect(d.needsOwner).toEqual(["format"]);

    recordOwnerAnswers(d.id, { format: "thread" }, db);
    const row = db.prepare("SELECT subject, owner_answers, needs_owner FROM decisions WHERE id = ?").get(d.id) as any;
    expect(row.subject).toBe("pr#16");
    expect(JSON.parse(row.owner_answers)).toEqual({ format: "thread" });
  });

  it("sends answers without a probability distribution to the owner", async () => {
    const db = openDb(":memory:");
    const model = mock({ format: { type: "choice", choice: "skip" }, link_worth_cost: { type: "boolean", probability: 0.95 } });
    const d = await decideGated({ schema, state: "text state", config, model, db });
    expect(d.needsOwner).toEqual(["format"]);
  });
});

describe("fitThreshold", () => {
  it("returns undefined until there are enough labels", () => {
    expect(fitThreshold([{ confidence: 0.9, correct: true }])).toBeUndefined();
  });

  it("finds the lowest threshold whose accepted answers reach the target accuracy", () => {
    const labeled = [
      ...Array.from({ length: 10 }, () => ({ confidence: 0.5, correct: false })),
      ...Array.from({ length: 20 }, () => ({ confidence: 0.9, correct: true })),
    ];
    expect(fitThreshold(labeled, 0.95, 20)).toBe(0.9);
  });
});

describe("OpenRouter state adapter", () => {
  it("sends OpenRouter's Decisions API a plain state and reads its probabilities", async () => {
    process.env.OPENROUTER_API_KEY ??= "test-key";
    let sent: any;
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      sent = { url, body: JSON.parse(init.body) };
      const answers = {
        format: { type: "choice", choice: "thread", probabilities: { skip: 0.01, post: 0.04, thread: 0.95 } },
        link_worth_cost: { type: "noul", noul: 0.05 },
      };
      return new Response(JSON.stringify({ id: "d1", model: "cloudflare/clef-flash", answers }), { headers: { "content-type": "application/json" } });
    });
    try {
      const schema = loadDecisionSchema("content-format", undefined, schemaRoots());
      const d = await decideGated({ schema, state: { brief: "new tool" }, config, db: openDb(":memory:") });
      expect(sent.url).toMatch(/\/decisions$/);
      expect(sent.body.model).toBe("cloudflare/clef-flash");
      expect(sent.body.state).toEqual({ brief: "new tool" });
      expect(d.answers.format).toMatchObject({ value: "thread", confidence: 0.95 });
      expect(d.needsOwner).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("turns ai@7 state parts back into plain text or JSON", () => {
    expect(plainState([{ type: "text", text: "hola" }])).toBe("hola");
    expect(plainState([{ type: "json", value: { a: 1 } }])).toEqual({ a: 1 });
    expect(plainState([{ type: "text", text: "a" }, { type: "json", value: 2 }])).toEqual(["a", 2]);
    expect(() => plainState([{ type: "file" }])).toThrow(ConfigError);
  });
});
