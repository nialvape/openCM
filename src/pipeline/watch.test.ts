import { describe, expect, it } from "vitest";
import { detectVersionBump, elideFiles, prefilter } from "../sources/github/changes.js";
import { extractJson } from "../core/structured.js";
import { openDb } from "../store/db.js";
import { getCursor, getEventByPr, setCursor } from "../store/events.js";
import { answer, fakeGitHub, mockModel, pr, prRoutes, testHarness, testProject, toolCall } from "../test-helpers.js";
import { repoTools } from "../tools/repo.js";
import type { PipelineDeps } from "./types.js";
import { analyzeEvent, pendingEvents, poll } from "./watch.js";

const project = testProject();

const brief = (n: number, extra: object = {}) =>
  JSON.stringify({
    pr: n,
    title: `PR ${n}`,
    summary: "Ahora se puede entrar con la TUP.",
    userFacing: true,
    changes: [{ id: "c1", kind: "feature", what: "TUP login", userImpact: "TUP students can log in", evidence: ["src/regionals.ts"] }],
    breaking: false,
    ...extra,
  });

function deps(routes: Record<string, unknown>, models: PipelineDeps["models"] = {}): PipelineDeps {
  const gh = fakeGitHub(routes);
  return { project, harness: testHarness(), db: openDb(":memory:"), gh, repoTools: repoTools(gh), models };
}

describe("change rules", () => {
  const code = { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@\n-a\n+b" };
  const lock = { filename: "package-lock.json", status: "modified", additions: 900, deletions: 800, patch: "x" };
  const ci = { filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 1, patch: "y" };

  it("keeps code patches and reduces lockfiles and ignored files to line counts", () => {
    const out = elideFiles([code, lock, ci], [".github/**"]);
    expect(out[0].patch).toBe(code.patch);
    expect(out[1]).toMatchObject({ elided: "generated or lockfile" });
    expect(out[1].patch).toBeUndefined();
    expect(out[2]).toMatchObject({ elided: "ignored by project prefilter" });
  });

  it("skips PRs that only touch ignored files, carry an ignored label or target another branch", () => {
    expect(prefilter(pr(1), [lock, ci], project)).toMatchObject({ skip: true });
    expect(prefilter(pr(1, { labels: [{ name: "ci" }] }), [code], project)).toMatchObject({ skip: true, reason: "label 'ci'" });
    expect(prefilter(pr(1, { base: { ref: "dev" } }), [code], project)).toMatchObject({ skip: true });
    expect(prefilter(pr(1), [code, lock], project)).toEqual({ skip: false });
  });

  it("detects a version bump in package.json", () => {
    const bump = { filename: "package.json", status: "modified", additions: 1, deletions: 1, patch: '@@\n-  "version": "0.8.0",\n+  "version": "0.9.0",' };
    expect(detectVersionBump([bump], project)).toBe("0.9.0");
    const other = { ...bump, patch: '@@\n-  "zod": "1",\n+  "zod": "2",' };
    expect(detectVersionBump([other], project)).toBeUndefined();
  });

  it("extracts JSON from fenced or bare answers", () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":2}')).toEqual({ a: 2 });
  });
});

describe("watching the repo", () => {
  it("starts from the last 24 hours, then only sees newer merges", async () => {
    const recent = pr(5, { merged_at: "2026-10-24T10:00:00Z", updated_at: "2026-10-24T10:00:00Z" });
    const old = pr(4, { merged_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z" });
    const unmerged = pr(6, { merged_at: null });
    const d = deps({ "/repos/o/r/pulls": [unmerged, recent, old] });

    const added = await poll(d, Date.parse("2026-10-24T20:00:00Z"));
    expect(added.map((e) => e.pr)).toEqual([5]);
    expect(getCursor(d.db, "demo")).toBe("2026-10-24T10:00:00Z");
    expect(await poll(d, Date.parse("2026-10-24T20:05:00Z"))).toEqual([]);
  });

  it("briefs a PR with the analyst, validating its JSON and retrying once", async () => {
    const p = pr(16);
    const files = [{ filename: "src/regionals.ts", status: "modified", additions: 10, deletions: 2, patch: "@@\n+tup" }];
    const analyst = mockModel(toolCall("repo_diff", { number: 16 }), answer("not json"), answer(brief(16)));
    const d = deps({ ...prRoutes(p, files), "/repos/o/r/pulls": [p] }, { analyst });
    setCursor(d.db, "demo", "2026-10-01T00:00:00Z");
    await poll(d);

    const [event] = pendingEvents(d);
    const result = await analyzeEvent(event, d);
    expect(result.status).toBe("briefed");
    expect(getEventByPr(d.db, "demo", 16)?.status).toBe("briefed");
    // The diff tool ran and its output reached the model, fenced.
    expect(JSON.stringify(analyst.doGenerateCalls[1].prompt)).toMatch(/UNTRUSTED DATA: diff of PR #16/);
    // The retry told the model what was wrong.
    expect(JSON.stringify(analyst.doGenerateCalls[2].prompt)).toContain("Your answer was not valid");
  });

  it("skips filtered PRs without calling any model", async () => {
    const p = pr(7);
    const d = deps({ ...prRoutes(p, [{ filename: ".github/workflows/x.yml", status: "modified", additions: 1, deletions: 1, patch: "x" }]), "/repos/o/r/pulls": [p] });
    setCursor(d.db, "demo", "2026-10-01T00:00:00Z");
    await poll(d);
    const result = await analyzeEvent(pendingEvents(d)[0], d);
    expect(result).toMatchObject({ status: "skipped" });
  });

  it("writes patch notes from every brief since the previous release when a PR bumps the version", async () => {
    const feature = pr(11, { merged_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z" });
    const release = pr(12, { merged_at: "2026-10-22T10:00:00Z", updated_at: "2026-10-22T10:00:00Z" });
    const featureFiles = [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+a" }];
    const releaseFiles = [{ filename: "package.json", status: "modified", additions: 1, deletions: 1, patch: '-  "version": "0.8.0",\n+  "version": "0.9.0",' }];
    const analyst = mockModel(answer(brief(11)), answer(brief(12, { summary: "Versión 0.9.0", changes: [{ id: "c1", kind: "internal", what: "bump", userImpact: "", evidence: ["package.json"] }], userFacing: false })));
    const writer = mockModel(answer("# 0.9.0\n\n- TUP (#11)"));
    const d = deps({ ...prRoutes(feature, featureFiles), ...prRoutes(release, releaseFiles), "/repos/o/r/pulls": [release, feature] }, { analyst, writer });
    setCursor(d.db, "demo", "2026-10-01T00:00:00Z");
    await poll(d);

    const results = [];
    for (const e of pendingEvents(d)) results.push(await analyzeEvent(e, d));
    const notes = results[1].status === "briefed" ? results[1].patchNotes : undefined;
    expect(notes?.version).toBe("0.9.0");
    expect(notes?.prs).toEqual([11]);
    expect(JSON.stringify(writer.doGenerateCalls[0].prompt)).toContain("TUP students can log in");
  });

  it("marks failures for retry and keeps the reason", async () => {
    const p = pr(9);
    const d = deps({ "/repos/o/r/pulls": [p] });
    setCursor(d.db, "demo", "2026-10-01T00:00:00Z");
    await poll(d);
    const result = await analyzeEvent(pendingEvents(d)[0], d);
    expect(result).toMatchObject({ status: "failed" });
    expect(pendingEvents(d)).toHaveLength(1);
  });
});
