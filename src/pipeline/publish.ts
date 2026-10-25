import { randomUUID } from "node:crypto";
import twitter from "twitter-text";
import { xClient, xCredentialsFromEnv, type XClient } from "../channels/x/client.js";
import { now } from "../store/db.js";
import { eventsForDraft, updateEvent } from "../store/events.js";
import { getDraft } from "./review.js";
import type { PipelineDeps } from "./types.js";

export interface PublishedPost {
  position: number;
  text: string;
  xId: string;
  url: string;
  dryRun: boolean;
}

export interface PublishResult {
  draftId: string;
  posts: PublishedPost[];
  costUsd: number;
  dryRun: boolean;
}

export class PublishError extends Error {
  name = "PublishError";
}

/** Dry run unless DRY_RUN is exactly "0": a missing or mistyped value never posts by accident. */
export const isDryRun = (env = process.env) => env.DRY_RUN?.trim() !== "0";

const postUrl = (xId: string, dryRun: boolean) => (dryRun ? `(dry run ${xId})` : `https://x.com/i/status/${xId}`);

/** USD spent on real posts today, for the daily cap. */
export function spentToday(deps: PipelineDeps): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = deps.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM posts WHERE project = ? AND dry_run = 0 AND posted_at >= ?").get(deps.project.id, today) as { c: number };
  return row.c;
}

/**
 * Publishes an approved draft: posts in order, each a reply to the previous one, then the link
 * reply. Plain code triggered by the owner's approval; no agent can call it. Already-posted parts
 * are skipped, so a publish that failed halfway can be retried without duplicates.
 */
export async function publishDraft(deps: PipelineDeps, draftId: string, opts: { client?: XClient; dryRun?: boolean } = {}): Promise<PublishResult> {
  const d = getDraft(deps, draftId);
  if (!d) throw new PublishError(`Draft ${draftId} not found`);
  if (d.status === "published") throw new PublishError("That draft is already published");
  if (d.status !== "approved") throw new PublishError(`Only approved drafts are published; this one is ${d.status}`);

  const dryRun = opts.dryRun ?? isDryRun();
  const draft = d.final ?? d.draft;
  const texts = [...draft.posts.map((p) => p.text), ...(draft.linkReply ? [draft.linkReply] : [])];
  const prices = deps.harness.x.prices;
  const costOf = (text: string) => (twitter.extractUrls(text).length ? prices.postWithLink : prices.post);

  const already = new Map(
    (deps.db.prepare("SELECT position, x_id FROM posts WHERE draft_id = ? AND x_id IS NOT NULL").all(draftId) as { position: number; x_id: string }[]).map((r) => [r.position, r.x_id]),
  );
  const remainingCost = texts.reduce((sum, t, i) => sum + (already.has(i) ? 0 : costOf(t)), 0);
  if (!dryRun && spentToday(deps) + remainingCost > deps.harness.x.maxSpendPerDayUsd) {
    throw new PublishError(`Publishing would cost $${remainingCost.toFixed(3)} and pass today's limit of $${deps.harness.x.maxSpendPerDayUsd} (x.maxSpendPerDayUsd). Try tomorrow or raise it.`);
  }
  const client = dryRun ? undefined : (opts.client ?? xClient(xCredentialsFromEnv()));

  const posts: PublishedPost[] = [];
  let replyTo: string | undefined;
  let cost = 0;
  for (const [i, text] of texts.entries()) {
    let xId = already.get(i);
    if (!xId) {
      xId = dryRun ? `dry-${randomUUID().slice(0, 8)}` : await client!.createPost(text, replyTo);
      const c = dryRun ? 0 : costOf(text);
      cost += c;
      deps.db
        .prepare("INSERT OR REPLACE INTO posts (project, draft_id, position, text, x_id, reply_to, has_link, cost_usd, dry_run, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(deps.project.id, draftId, i, text, xId, replyTo ?? null, twitter.extractUrls(text).length ? 1 : 0, c, dryRun ? 1 : 0, now());
      if (dryRun) console.log(`[dry run] would post${replyTo ? ` in reply to ${replyTo}` : ""}:\n${text}\n`);
    }
    posts.push({ position: i, text, xId, url: postUrl(xId, dryRun), dryRun });
    replyTo = xId;
  }

  deps.db.prepare("UPDATE drafts SET status = 'published', updated_at = ? WHERE id = ?").run(now(), draftId);
  for (const e of eventsForDraft(deps.db, draftId)) updateEvent(deps.db, e.id, { status: "published" });
  return { draftId, posts, costUsd: cost, dryRun };
}

/** Posts whose metrics at `afterHours` are due and not read yet (real posts only). */
export function postsDueForMetrics(deps: PipelineDeps, afterHours: number, nowMs = Date.now()): string[] {
  const cutoff = new Date(nowMs - afterHours * 3_600_000).toISOString();
  const rows = deps.db
    .prepare(
      `SELECT p.x_id FROM posts p WHERE p.project = ? AND p.dry_run = 0 AND p.x_id IS NOT NULL AND p.posted_at <= ?
       AND NOT EXISTS (SELECT 1 FROM post_metrics m WHERE m.x_id = p.x_id AND m.after_hours = ?)`,
    )
    .all(deps.project.id, cutoff, afterHours) as { x_id: string }[];
  return rows.map((r) => r.x_id);
}

/**
 * Reads engagement for posts that reached each checkpoint (24h, 7d…). Engagement is the outcome
 * signal outside the model that later credits the memory used to write each post.
 */
export async function collectMetrics(deps: PipelineDeps, opts: { client?: XClient; nowMs?: number } = {}): Promise<number> {
  if (isDryRun() && !opts.client) return 0;
  let stored = 0;
  for (const hours of deps.harness.x.metricsAfterHours) {
    const due = postsDueForMetrics(deps, hours, opts.nowMs);
    if (due.length === 0) continue;
    const client = opts.client ?? xClient(xCredentialsFromEnv());
    for (let i = 0; i < due.length; i += 100) {
      const batch = due.slice(i, i + 100);
      const metrics = await client.metrics(batch);
      for (const id of batch) {
        const m = metrics[id];
        // Deleted posts return nothing; store zeros so they aren't read (and paid for) again.
        deps.db
          .prepare("INSERT OR REPLACE INTO post_metrics (x_id, after_hours, impressions, likes, reposts, replies, quotes, bookmarks, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, hours, m?.impression_count ?? null, m?.like_count ?? 0, m?.retweet_count ?? 0, m?.reply_count ?? 0, m?.quote_count ?? 0, m?.bookmark_count ?? null, now());
        stored++;
      }
    }
  }
  return stored;
}
