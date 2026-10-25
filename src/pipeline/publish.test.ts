import { describe, expect, it } from "vitest";
import { oauth1Header } from "../channels/x/oauth1.js";
import type { XClient } from "../channels/x/client.js";
import { openDb } from "../store/db.js";
import { addEvent, getEventByPr, updateEvent } from "../store/events.js";
import { fakeGitHub, testHarness, testProject } from "../test-helpers.js";
import { repoTools } from "../tools/repo.js";
import { collectMetrics, isDryRun, postsDueForMetrics, publishDraft } from "./publish.js";
import { approveDraft, getDraft } from "./review.js";
import type { PipelineDeps } from "./types.js";

function deps(): PipelineDeps {
  const gh = fakeGitHub({});
  return { project: testProject(), harness: testHarness(), db: openDb(":memory:"), gh, repoTools: repoTools(gh) };
}

/** An approved thread draft for PR 16, inserted directly. */
function approvedThread(d: PipelineDeps, linkReply = "Instalalo: github.com/o/r"): string {
  addEvent(d.db, { project: "demo", pr: 16, title: "TUP", url: "u", mergedAt: "2026-10-24T00:00:00Z" });
  const draft = { format: "thread", posts: [{ text: "uno", claims: ["16:c1"] }, { text: "dos", claims: ["16:c1"] }], linkReply };
  d.db
    .prepare("INSERT INTO drafts (id, project, prs, format, content, checks, revisions, status, created_at, updated_at) VALUES ('d1', 'demo', '[16]', 'thread', ?, '[]', 0, 'pending', ?, ?)")
    .run(JSON.stringify(draft), new Date().toISOString(), new Date().toISOString());
  updateEvent(d.db, "demo:pr:16", { status: "drafted", draftId: "d1" });
  approveDraft(d, "d1");
  return "d1";
}

function fakeX(failOn?: number): XClient & { posted: { text: string; replyTo?: string }[] } {
  const posted: { text: string; replyTo?: string }[] = [];
  return {
    posted,
    async createPost(text, replyTo) {
      if (failOn !== undefined && posted.length === failOn) {
        failOn = undefined;
        throw new Error("X 503");
      }
      posted.push({ text, replyTo });
      return `x${posted.length}`;
    },
    async metrics(ids) {
      return Object.fromEntries(ids.map((id) => [id, { impression_count: 100, like_count: 5, retweet_count: 1, reply_count: 2, quote_count: 0, bookmark_count: 1 }]));
    },
  };
}

describe("OAuth 1.0a", () => {
  it("matches the signature of X's documented example", () => {
    const header = oauth1Header(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      {
        consumerKey: "xvz1evFS4wEEPTGEFPHBog",
        consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      "1318622958",
    );
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });
});

describe("publishDraft", () => {
  it("is a dry run unless DRY_RUN is exactly 0", () => {
    expect(isDryRun({})).toBe(true);
    expect(isDryRun({ DRY_RUN: "1" })).toBe(true);
    expect(isDryRun({ DRY_RUN: "false" })).toBe(true);
    expect(isDryRun({ DRY_RUN: "0" })).toBe(false);
  });

  it("dry run posts nothing and costs nothing", async () => {
    const d = deps();
    const x = fakeX();
    const r = await publishDraft(d, approvedThread(d), { client: x, dryRun: true });
    expect(x.posted).toEqual([]);
    expect(r.costUsd).toBe(0);
    expect(r.posts).toHaveLength(3);
    expect(getDraft(d, "d1")?.status).toBe("published");
  });

  it("posts a thread as a reply chain with the link reply last, priced by link", async () => {
    const d = deps();
    const x = fakeX();
    const r = await publishDraft(d, approvedThread(d), { client: x, dryRun: false });
    expect(x.posted).toEqual([{ text: "uno", replyTo: undefined }, { text: "dos", replyTo: "x1" }, { text: "Instalalo: github.com/o/r", replyTo: "x2" }]);
    expect(r.costUsd).toBeCloseTo(0.015 + 0.015 + 0.2);
    expect(getEventByPr(d.db, "demo", 16)?.status).toBe("published");
    await expect(publishDraft(d, "d1", { client: x, dryRun: false })).rejects.toThrow(/already published/);
  });

  it("refuses to publish past the daily spend limit", async () => {
    const d = deps();
    d.harness = { ...d.harness, x: { ...d.harness.x, maxSpendPerDayUsd: 0.1 } };
    await expect(publishDraft(d, approvedThread(d), { client: fakeX(), dryRun: false })).rejects.toThrow(/limit/);
  });

  it("resumes a half-published thread without posting twice", async () => {
    const d = deps();
    const x = fakeX(1);
    const id = approvedThread(d);
    await expect(publishDraft(d, id, { client: x, dryRun: false })).rejects.toThrow("X 503");
    expect(getDraft(d, id)?.status).toBe("approved");
    await publishDraft(d, id, { client: x, dryRun: false });
    expect(x.posted.map((p) => p.text)).toEqual(["uno", "dos", "Instalalo: github.com/o/r"]);
    expect(x.posted[1].replyTo).toBe("x1");
  });

  it("only publishes approved drafts", async () => {
    const d = deps();
    approvedThread(d);
    d.db.prepare("UPDATE drafts SET status = 'pending'").run();
    await expect(publishDraft(d, "d1", { dryRun: true })).rejects.toThrow(/Only approved/);
  });
});

describe("metrics", () => {
  it("reads each real post once per checkpoint", async () => {
    const d = deps();
    const x = fakeX();
    await publishDraft(d, approvedThread(d, ""), { client: x, dryRun: false });
    const posted = Date.now();
    expect(postsDueForMetrics(d, 24, posted)).toEqual([]);
    const dayLater = posted + 25 * 3_600_000;
    expect(postsDueForMetrics(d, 24, dayLater)).toEqual(["x1", "x2"]);
    expect(await collectMetrics(d, { client: x, nowMs: dayLater })).toBe(2);
    expect(postsDueForMetrics(d, 24, dayLater)).toEqual([]);
    const row = d.db.prepare("SELECT likes, impressions FROM post_metrics WHERE x_id = 'x1' AND after_hours = 24").get() as any;
    expect(row).toEqual({ likes: 5, impressions: 100 });
  });
});
