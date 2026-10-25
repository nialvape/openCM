import { describe, expect, it } from "vitest";
import { draftCard, formatQuestion, parseCallback } from "../channels/telegram/cards.js";
import { decideGated, loadDecisionSchema } from "../core/decision.js";
import { Experimental_DecisionMockModelV4 as DecisionMock } from "ai/test";
import { openDb } from "../store/db.js";
import { addEvent, getEventByPr, updateEvent } from "../store/events.js";
import { answer, fakeGitHub, mockModel, testHarness, testProject } from "../test-helpers.js";
import { repoTools } from "../tools/repo.js";
import type { ChangeBrief } from "./brief.js";
import { draftFor } from "./flow.js";
import { answerFormat, approveDraft, getDraft, pendingDrafts, reformatDraft, rejectDraft, replaceDraftText, reviseDraft } from "./review.js";
import type { PipelineDeps } from "./types.js";

const brief = (n: number): ChangeBrief => ({
  pr: n,
  title: `PR ${n}`,
  summary: `cambio ${n}`,
  userFacing: true,
  changes: [{ id: "c1", kind: "feature", what: `feature ${n}`, userImpact: `podés usar ${n}`, evidence: ["src/a.ts"] }],
  breaking: false,
  upgradeSteps: [],
});
const ok = answer(JSON.stringify({ scores: { accuracy: 5, clarity: 4, hook: 4, voice: 4, value: 4, noHype: 5 }, verdict: "ok", fixes: [] }));
const post = (text: string, n = 16) => answer(JSON.stringify({ format: "post", posts: [{ text, claims: [`${n}:c1`] }] }));

function setup(writerTexts: string[]) {
  const gh = fakeGitHub({});
  const deps: PipelineDeps = {
    project: testProject(),
    harness: testHarness(),
    db: openDb(":memory:"),
    gh,
    repoTools: repoTools(gh),
    models: { writer: mockModel(...writerTexts.map((t) => post(t))), critic: mockModel(ok, ok, ok, ok) },
  };
  addEvent(deps.db, { project: "demo", pr: 16, title: "TUP", url: "https://github.com/o/r/pull/16", mergedAt: "2026-10-24T00:00:00Z" });
  updateEvent(deps.db, "demo:pr:16", { status: "briefed", brief: brief(16) });
  return deps;
}

async function decisionFor(deps: PipelineDeps): Promise<string> {
  const model = new DecisionMock({
    doDecide: async () => ({
      answers: {
        format: { type: "choice", choice: "post", probabilities: { skip: 0.1, hold: 0.2, post: 0.4, thread: 0.3 } },
        merge_with_held: { type: "boolean", probability: 0.1 },
        link_worth_cost: { type: "boolean", probability: 0.1 },
      } as any,
      warnings: [],
    }),
  });
  const d = await decideGated({ schema: loadDecisionSchema("content-format", "demo"), state: {}, config: deps.harness.decisions, projectId: "demo", subject: "pr#16", db: deps.db, model });
  return d.id;
}

describe("telegram cards", () => {
  it("parses button data and rejects anything else", () => {
    expect(parseCallback("d:abc-123:approve")).toEqual({ kind: "draft", draftId: "abc-123", action: "approve" });
    expect(parseCallback("d:abc:to_thread")).toEqual({ kind: "draft", draftId: "abc", action: "to_thread" });
    expect(parseCallback("f:demo:pr:16:hold")).toEqual({ kind: "format", eventId: "demo:pr:16", format: "hold" });
    expect(parseCallback("d:abc:publish_everything")).toBeUndefined();
    expect(parseCallback("x")).toBeUndefined();
  });

  it("keeps button data under Telegram's 64-byte limit", async () => {
    const deps = setup(["Ya podés usar la TUP."]);
    const out = await draftFor(getEventByPr(deps.db, "demo", 16)!, "post", deps);
    if (out.kind !== "drafted") throw new Error("expected a draft");
    const card = draftCard(getDraft(deps, out.draft.id)!, [getEventByPr(deps.db, "demo", 16)!]);
    const data = card.keyboard.inline_keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : ""));
    expect(data.every((d) => Buffer.byteLength(d) <= 64)).toBe(true);
    expect(card.text).toContain("Ya podés usar la TUP.");
    const q = formatQuestion(getEventByPr(deps.db, "demo", 16)!, { reason: "unsure", probabilities: { post: 0.4 } });
    expect(q.text).toContain("Single post 40%");
  });
});

describe("owner review", () => {
  it("approving labels the decision with the format the owner kept", async () => {
    const deps = setup(["Ya podés usar la TUP."]);
    const decisionId = await decisionFor(deps);
    updateEvent(deps.db, "demo:pr:16", { decisionId });
    const out = await draftFor(getEventByPr(deps.db, "demo", 16)!, "post", deps);
    if (out.kind !== "drafted") throw new Error("expected a draft");

    approveDraft(deps, out.draft.id);
    expect(getDraft(deps, out.draft.id)?.status).toBe("approved");
    expect(getEventByPr(deps.db, "demo", 16)?.status).toBe("approved");
    const row = deps.db.prepare("SELECT owner_answers FROM decisions WHERE id = ?").get(decisionId) as { owner_answers: string };
    expect(JSON.parse(row.owner_answers)).toEqual({ format: "post" });
    expect(() => approveDraft(deps, out.draft.id)).toThrow(/already approved/);
  });

  it("replaces the text verbatim, re-running the checks", async () => {
    const deps = setup(["Ya podés usar la TUP."]);
    const out = await draftFor(getEventByPr(deps.db, "demo", 16)!, "post", deps);
    if (out.kind !== "drafted") throw new Error("expected a draft");
    const edited = replaceDraftText(deps, out.draft.id, "Mirá github.com/o/r");
    expect(edited.final?.posts[0].text).toBe("Mirá github.com/o/r");
    expect(edited.issues.map((i) => i.check)).toContain("link_policy");
    approveDraft(deps, out.draft.id);
    expect(getDraft(deps, out.draft.id)?.final?.posts[0].text).toBe("Mirá github.com/o/r");
  });

  it("rewrites on an instruction and supersedes the old draft", async () => {
    const deps = setup(["Ya podés usar la TUP, una maravilla.", "TUP: ya funciona."]);
    const out = await draftFor(getEventByPr(deps.db, "demo", 16)!, "post", deps);
    if (out.kind !== "drafted") throw new Error("expected a draft");
    const revised = await reviseDraft(deps, out.draft.id, "más corto");
    expect(revised.draft.draft.posts[0].text).toBe("TUP: ya funciona.");
    expect(getDraft(deps, out.draft.id)?.status).toBe("superseded");
    expect(pendingDrafts(deps).map((d) => d.id)).toEqual([revised.draft.id]);
    expect(JSON.stringify((deps.models!.writer as any).doGenerateCalls[1].prompt)).toContain("más corto");
  });

  it("switching to hold moves the change to the digest queue", async () => {
    const deps = setup(["Ya podés usar la TUP."]);
    const out = await draftFor(getEventByPr(deps.db, "demo", 16)!, "post", deps);
    if (out.kind !== "drafted") throw new Error("expected a draft");
    const [o] = await reformatDraft(deps, out.draft.id, "hold");
    expect(o.kind).toBe("held");
    expect(getEventByPr(deps.db, "demo", 16)?.status).toBe("held");
  });

  it("rejecting keeps the change out of the queue", async () => {
    const deps = setup(["Ya podés usar la TUP."]);
    const out = await draftFor(getEventByPr(deps.db, "demo", 16)!, "post", deps);
    if (out.kind !== "drafted") throw new Error("expected a draft");
    rejectDraft(deps, out.draft.id, "no es relevante");
    expect(getEventByPr(deps.db, "demo", 16)).toMatchObject({ status: "rejected", reason: "no es relevante" });
  });

  it("answering a format question drafts in that format and labels the decision", async () => {
    const deps = setup(["Ya podés usar la TUP."]);
    const decisionId = await decisionFor(deps);
    updateEvent(deps.db, "demo:pr:16", { status: "awaiting_format", decisionId });
    const o = await answerFormat(deps, "demo:pr:16", "post");
    expect(o.kind).toBe("drafted");
    const row = deps.db.prepare("SELECT owner_answers FROM decisions WHERE id = ?").get(decisionId) as { owner_answers: string };
    expect(JSON.parse(row.owner_answers)).toEqual({ format: "post" });
    await expect(answerFormat(deps, "demo:pr:16", "skip")).rejects.toThrow(/already drafted/);
  });
});
