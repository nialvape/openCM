import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCallback } from "../channels/telegram/cards.js";
import { paths } from "../core/paths.js";
import { openDb } from "../store/db.js";
import { addEvent, getEventByPr, updateEvent } from "../store/events.js";
import { answer, fakeGitHub, mockModel, testHarness, testProject } from "../test-helpers.js";
import { repoTools } from "../tools/repo.js";
import type { ChangeBrief } from "./brief.js";
import { draftFor } from "./flow.js";
import { creditFromMetrics, evict, selectExamples } from "./memory.js";
import { decideLesson, lessonsFile, pendingLessons, reflect, reflectCases } from "./reflect.js";
import { approveDraft, rejectDraft, replaceDraftText } from "./review.js";
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
const postFor = (n: number, text: string) => answer(JSON.stringify({ format: "post", posts: [{ text, claims: [`${n}:c1`] }] }));

function setup(projectId = "demo") {
  const gh = fakeGitHub({});
  const deps: PipelineDeps = {
    project: testProject({ id: projectId }),
    harness: testHarness(),
    db: openDb(":memory:"),
    gh,
    repoTools: repoTools(gh),
    models: {
      writer: mockModel(...[1, 2, 3, 4, 5, 6].map((n) => postFor(15 + n, `post ${15 + n} 🚀🚀`))),
      critic: mockModel(ok, ok, ok, ok, ok, ok),
    },
  };
  return deps;
}

async function draftOf(deps: PipelineDeps, n: number) {
  addEvent(deps.db, { project: deps.project.id, pr: n, title: `PR ${n}`, url: "u", mergedAt: `2026-10-2${n % 10}T00:00:00Z` });
  updateEvent(deps.db, `${deps.project.id}:pr:${n}`, { status: "briefed", brief: brief(n) });
  const out = await draftFor(getEventByPr(deps.db, deps.project.id, n)!, "post", deps);
  if (out.kind !== "drafted") throw new Error("expected a draft");
  return out.draft.id;
}

describe("examples memory", () => {
  it("keeps approved posts as examples, shows them to the writer and credits them by outcome", async () => {
    const deps = setup();
    const first = await draftOf(deps, 16);
    approveDraft(deps, first);
    const [example] = selectExamples(deps.db, "demo", "post", 3);
    expect(example).toMatchObject({ text: "post 16 🚀🚀", score: 1 });

    const second = await draftOf(deps, 17);
    expect(JSON.stringify((deps.models!.writer as any).doGenerateCalls[1].prompt)).toContain("post 16 🚀🚀");
    rejectDraft(deps, second, "demasiados emojis");
    expect(selectExamples(deps.db, "demo", "post", 3)[0].score).toBe(0); // 1 approved, −1 for the rejected draft that used it
  });

  it("credits examples by engagement relative to the median", async () => {
    const deps = setup();
    // Examples off: each example is then credited only by its own post's engagement.
    deps.harness = { ...deps.harness, memory: { ...deps.harness.memory, examplesPerDraft: 0 } };
    const ids = [];
    for (const n of [16, 17, 18]) {
      const id = await draftOf(deps, n);
      approveDraft(deps, id);
      ids.push(id);
    }
    const insertPost = deps.db.prepare("INSERT INTO posts (project, draft_id, position, text, x_id, has_link, cost_usd, dry_run, posted_at) VALUES ('demo', ?, 0, 't', ?, 0, 0.015, 0, ?)");
    const insertMetric = deps.db.prepare("INSERT INTO post_metrics (x_id, after_hours, likes, reposts, replies, quotes, fetched_at) VALUES (?, 24, ?, 0, 0, 0, ?)");
    const now = new Date().toISOString();
    [2, 4, 12].forEach((likes, i) => {
      insertPost.run(ids[i], `x${i}`, now);
      insertMetric.run(`x${i}`, likes, now);
    });
    expect(creditFromMetrics(deps, 24)).toBe(3);
    expect(creditFromMetrics(deps, 24)).toBe(0); // once per checkpoint
    const scores = deps.db.prepare("SELECT source_draft, score FROM memory_items ORDER BY id").all() as { source_draft: string; score: number }[];
    const byDraft = Object.fromEntries(scores.map((s) => [s.source_draft, s.score]));
    expect(byDraft[ids[2]]).toBeGreaterThan(byDraft[ids[1]]);
    expect(byDraft[ids[0]]).toBeLessThan(byDraft[ids[1]]);
  });

  it("evicts the lowest-scored examples past the cap", () => {
    const deps = setup();
    const ins = deps.db.prepare("INSERT INTO memory_items (project, kind, format, text, score, created_at, updated_at) VALUES ('demo', 'example', 'post', ?, ?, ?, ?)");
    [3, -1, 2].forEach((s, i) => ins.run(`e${i}`, s, `2026-10-0${i + 1}`, `2026-10-0${i + 1}`));
    expect(evict(deps.db, "demo", 2)).toBe(1);
    expect(selectExamples(deps.db, "demo", "post", 5).map((e) => e.text)).toEqual(["e0", "e2"]);
  });
});

describe("reflect", () => {
  it("proposes lessons from corrections, drops invented evidence, keeps what the reviewer keeps, and writes accepted ones", async () => {
    const projectId = "reflect-demo";
    mkdirSync(paths.projectDir(projectId), { recursive: true });
    rmSync(lessonsFile(projectId), { force: true });
    const deps = setup(projectId);
    const a = await draftOf(deps, 16);
    rejectDraft(deps, a, "demasiados emojis");
    const b = await draftOf(deps, 17);
    replaceDraftText(deps, b, "post 17");
    approveDraft(deps, b);
    expect(reflectCases(deps).map((c) => c.kind)).toEqual(["rejected", "edited"]);

    // Below reflectAfter (3) nothing runs unless forced.
    expect(await reflect(deps)).toEqual([]);

    deps.models!.reflect = mockModel(
      answer(
        JSON.stringify({
          proposals: [
            { lesson: "No uses emojis en los posts.", evidence: [a, b], reason: "rechazó uno por emojis y los sacó del otro" },
            { lesson: "Siempre mencioná el precio.", evidence: ["invented-id"], reason: "?" },
            { lesson: "Escribí posts más largos.", evidence: [b], reason: "?" },
          ],
        }),
      ),
    );
    deps.models!.reviewer = mockModel(answer(JSON.stringify({ reviews: [{ index: 0, keep: true, why: "both cases show it" }, { index: 1, keep: false, why: "the edit made it shorter" }] })));
    const proposals = await reflect(deps, true);
    expect(proposals.map((p) => p.text)).toEqual(["No uses emojis en los posts."]);
    // The invented-evidence proposal never reached the reviewer.
    expect(JSON.stringify((deps.models!.reviewer as any).doGenerateCalls[0].prompt)).not.toContain("precio");
    // Corrections already reflected on aren't used again.
    expect(reflectCases(deps)).toEqual([]);

    decideLesson(deps, proposals[0].id, true);
    expect(readFileSync(lessonsFile(projectId), "utf8")).toContain("- No uses emojis en los posts.");
    expect(pendingLessons(deps)).toEqual([]);
    expect(() => decideLesson(deps, proposals[0].id, false)).toThrow(/already accepted/);
    rmSync(paths.projectDir(projectId), { recursive: true, force: true });
    expect(existsSync(lessonsFile(projectId))).toBe(false);
  });

  it("parses lesson buttons", () => {
    expect(parseCallback("l:12:accept")).toEqual({ kind: "lesson", lessonId: 12, accept: true });
    expect(parseCallback("l:12:discard")).toEqual({ kind: "lesson", lessonId: 12, accept: false });
    expect(parseCallback("l:x:accept")).toBeUndefined();
  });
});
