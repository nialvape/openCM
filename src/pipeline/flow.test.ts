import { describe, expect, it } from "vitest";
import { Experimental_DecisionMockModelV4 as DecisionMock } from "ai/test";
import { runChecks } from "../checks/checks.js";
import { summarize, withOverrides } from "../evals/run.js";
import { openDb } from "../store/db.js";
import { addEvent, getEventByPr, updateEvent } from "../store/events.js";
import { answer, fakeGitHub, mockModel, pr, prRoutes, testHarness, testProject } from "../test-helpers.js";
import { repoTools } from "../tools/repo.js";
import type { ChangeBrief } from "./brief.js";
import { composeDraft, needsRevision, weightedScore, type Draft } from "./draft.js";
import { advance, maybeDigest } from "./flow.js";
import type { PipelineDeps } from "./types.js";

const project = testProject({ bannedTerms: ["revolucionario"], posting: { maxPostsPerDay: 1, digestMinItems: 2 } });

const brief = (n: number, extra: Partial<ChangeBrief> = {}): ChangeBrief => ({
  pr: n,
  title: `PR ${n}`,
  summary: `cambio ${n}`,
  userFacing: true,
  changes: [{ id: "c1", kind: "feature", what: `feature ${n}`, userImpact: `podés usar ${n}`, evidence: ["src/a.ts"] }],
  breaking: false,
  upgradeSteps: [],
  ...extra,
});

const draftJson = (d: Partial<Draft> & { posts: Draft["posts"] }) => JSON.stringify({ format: "post", ...d });
const okCritique = JSON.stringify({ scores: { accuracy: 5, clarity: 4, hook: 4, voice: 4, value: 4, noHype: 5 }, verdict: "ok", fixes: [] });
const badCritique = JSON.stringify({ scores: { accuracy: 2, clarity: 4, hook: 3, voice: 4, value: 4, noHype: 5 }, verdict: "revise", fixes: ["post 1 says 'todas las regionales'; the brief only covers the TUP"] });

function deps(routes: Record<string, unknown> = {}, models: PipelineDeps["models"] = {}): PipelineDeps {
  const gh = fakeGitHub(routes);
  return { project, harness: testHarness(), db: openDb(":memory:"), gh, repoTools: repoTools(gh), models };
}

const decision = (format: string, p: number) =>
  new DecisionMock({
    doDecide: async () => ({
      answers: {
        format: { type: "choice", choice: format, probabilities: { skip: 0, hold: 0, post: 0, thread: 0, [format]: p, ...(p < 1 ? { skip: 1 - p } : {}) } },
        merge_with_held: { type: "boolean", probability: 0.05 },
        link_worth_cost: { type: "boolean", probability: 0.05 },
      } as any,
      warnings: [],
    }),
  });

describe("deterministic checks", () => {
  const briefs = [brief(16)];
  it("passes a clean post", () => {
    expect(runChecks({ format: "post", posts: [{ text: "Ya podés usar la TUP.", claims: ["16:c1"] }] }, briefs, project)).toEqual([]);
  });

  it("flags length, links in posts, unknown claims, banned terms, secrets and shape", () => {
    const issues = runChecks(
      {
        format: "post",
        posts: [
          { text: `${"a".repeat(281)}`, claims: ["16:c9"] },
          { text: "Mirá github.com/o/r, es revolucionario. token sk-ant-abcdefghijklmnopqrstuvwxyz123", claims: [] },
        ],
      },
      briefs,
      project,
    );
    expect(new Set(issues.map((i) => i.check))).toEqual(new Set(["shape", "length", "claims", "link_policy", "banned_term", "secret"]));
  });

  it("weights accuracy most and sends low accuracy back", () => {
    const c = JSON.parse(badCritique);
    expect(needsRevision(c)).toBe(true);
    expect(weightedScore(JSON.parse(okCritique))).toBeGreaterThan(4);
  });
});

describe("composeDraft", () => {
  it("rewrites after failed checks, then after the critic, and stores the result", async () => {
    const writer = mockModel(
      answer(draftJson({ posts: [{ text: "Mirá github.com/o/r", claims: ["16:c1"] }] })),
      answer(draftJson({ posts: [{ text: "Todas las regionales ya funcionan.", claims: ["16:c1"] }] })),
      answer(draftJson({ posts: [{ text: "Ya podés usar la TUP.", claims: ["16:c1"] }] })),
    );
    const critic = mockModel(answer(badCritique), answer(okCritique));
    const d = deps({}, { writer, critic });
    const out = await composeDraft({ format: "post", briefs: [brief(16)] }, d);

    expect(out.revisions).toBe(2);
    expect(out.issues).toEqual([]);
    expect(out.draft.posts[0].text).toBe("Ya podés usar la TUP.");
    expect(JSON.stringify(writer.doGenerateCalls[1].prompt)).toContain("Links go only in linkReply");
    expect(JSON.stringify(writer.doGenerateCalls[2].prompt)).toContain("todas las regionales");
    const row = d.db.prepare("SELECT status, revisions FROM drafts WHERE id = ?").get(out.id) as any;
    expect(row).toMatchObject({ status: "pending", revisions: 2 });
  });
});

describe("advance", () => {
  const files = [{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "+x" }];

  function seeded(d: PipelineDeps, n: number, b: ChangeBrief) {
    addEvent(d.db, { project: "demo", pr: n, title: `PR ${n}`, url: "u", mergedAt: `2026-10-2${n % 10}T00:00:00Z` });
    updateEvent(d.db, `demo:pr:${n}`, { status: "briefed", brief: b });
    return getEventByPr(d.db, "demo", n)!;
  }

  it("goes from a merged PR to a draft when the decision model is confident", async () => {
    const p = pr(16);
    const analyst = mockModel(answer(JSON.stringify(brief(16))));
    const writer = mockModel(answer(draftJson({ posts: [{ text: "Ya podés usar la TUP.", claims: ["16:c1"] }] })));
    const critic = mockModel(answer(okCritique));
    const d = deps(prRoutes(p, files), { analyst, writer, critic });
    addEvent(d.db, { project: "demo", pr: 16, title: p.title, url: p.html_url, mergedAt: p.merged_at! });

    const out = await advance(getEventByPr(d.db, "demo", 16)!, d, decision("post", 0.95));
    expect(out.kind).toBe("drafted");
    expect(getEventByPr(d.db, "demo", 16)).toMatchObject({ status: "drafted", format: "post" });
  });

  it("asks the owner when the model isn't confident", async () => {
    const d = deps();
    const out = await advance(seeded(d, 17, brief(17)), d, decision("post", 0.55));
    expect(out.kind).toBe("ask_format");
    expect(getEventByPr(d.db, "demo", 17)?.status).toBe("awaiting_format");
  });

  it("asks the owner when the decision model fails, instead of stopping", async () => {
    const d = deps();
    const broken = new DecisionMock({ doDecide: async () => Promise.reject(new Error("model not found")) });
    const out = await advance(seeded(d, 18, brief(18)), d, broken);
    expect(out).toMatchObject({ kind: "ask_format" });
  });

  it("skips briefs with nothing user-facing without asking any model", async () => {
    const d = deps();
    const out = await advance(seeded(d, 19, brief(19, { userFacing: false })), d, decision("thread", 1));
    expect(out).toMatchObject({ kind: "skipped", reason: "no user-facing change in the brief" });
  });

  it("holds posts past the daily cap and drafts a digest once enough are held", async () => {
    const writer = mockModel(answer(JSON.stringify({ format: "digest", posts: [{ text: "Mejoras: 21 y 22", claims: ["21:c1", "22:c1"] }] })));
    const critic = mockModel(answer(okCritique));
    const d = deps({}, { writer, critic });
    d.db.prepare("INSERT INTO drafts (id, project, prs, format, content, checks, revisions, status, created_at, updated_at) VALUES ('x', 'demo', '[]', 'post', '{}', '[]', 0, 'published', ?, ?)").run(new Date().toISOString(), new Date().toISOString());

    expect(await advance(seeded(d, 21, brief(21)), d, decision("post", 0.99))).toMatchObject({ kind: "held", reason: "daily cap of 1 posts reached" });
    expect(await maybeDigest(d)).toBeUndefined();
    await advance(seeded(d, 22, brief(22)), d, decision("hold", 0.99));
    const digest = await maybeDigest(d);
    expect(digest?.kind).toBe("drafted");
    expect(getEventByPr(d.db, "demo", 21)).toMatchObject({ status: "drafted", format: "digest" });
  });
});

describe("evals", () => {
  it("summarizes accuracy, checks, critic scores, forbidden text and cost", () => {
    const s = summarize([
      { name: "a", pr: 1, formatSource: "model", formatCorrect: true, checksPassed: true, checkIssues: [], criticScore: 4, mentionMissing: [], avoidFound: [], costUsd: 0.01, content: "x" },
      { name: "b", pr: 2, formatSource: "model", formatCorrect: false, checksPassed: false, checkIssues: ["x"], criticScore: 3, mentionMissing: ["TUP"], avoidFound: ["SCAMCOIN"], costUsd: 0.02, content: "y" },
    ]);
    expect(s).toMatchObject({ formatAccuracy: 0.5, checkPassRate: 0.5, meanCriticScore: 3.5, mentionRate: 0.5, avoidViolations: 1, failures: 0, costUsd: 0.03 });
  });

  it("overrides a role's model from the command line", () => {
    const h = withOverrides(testHarness(), { writer: "openrouter:openai/gpt-6-luna", decisions: "openrouter:cloudflare/clef" });
    expect(h.roles.writer.model).toBe("openrouter:openai/gpt-6-luna");
    expect(h.roles.writer.maxSteps).toBe(6);
    expect(h.decisions.model).toBe("openrouter:cloudflare/clef");
  });
});
