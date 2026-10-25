import { ConfigError } from "../../core/config.js";
import { oauth1Header, type OAuth1Credentials } from "./oauth1.js";

const API = "https://api.x.com/2";

export class XError extends Error {
  name = "XError";
}

export interface PublicMetrics {
  impression_count?: number;
  like_count: number;
  retweet_count: number;
  reply_count: number;
  quote_count: number;
  bookmark_count?: number;
}

/** Only the X API calls openCM makes: create a post (optionally as a reply) and read post metrics. */
export interface XClient {
  createPost(text: string, replyTo?: string): Promise<string>;
  metrics(ids: string[]): Promise<Record<string, PublicMetrics>>;
}

export function xCredentialsFromEnv(env = process.env): OAuth1Credentials {
  const creds = { consumerKey: env.X_API_KEY, consumerSecret: env.X_API_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_SECRET };
  const missing = Object.entries({ X_API_KEY: creds.consumerKey, X_API_SECRET: creds.consumerSecret, X_ACCESS_TOKEN: creds.token, X_ACCESS_SECRET: creds.tokenSecret })
    .filter(([, v]) => !v?.trim())
    .map(([k]) => k);
  if (missing.length) throw new ConfigError(`Set ${missing.join(", ")} in .env (X developer app, OAuth 1.0a user tokens of the account that posts), or keep DRY_RUN=1.`);
  return creds as OAuth1Credentials;
}

async function check(res: Response, what: string): Promise<any> {
  const body = await res.text();
  if (res.status === 402 || res.status === 429) throw new XError(`X refused ${what} (${res.status}): spending limit or rate limit reached. ${body.slice(0, 200)}`);
  if (res.status === 401 || res.status === 403) throw new XError(`X rejected the credentials for ${what} (${res.status}). Check the four X_* values and that the app has write access. ${body.slice(0, 200)}`);
  if (!res.ok) throw new XError(`X ${res.status} for ${what}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

export function xClient(creds: OAuth1Credentials): XClient {
  return {
    async createPost(text, replyTo) {
      const url = `${API}/tweets`;
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: oauth1Header("POST", url, creds), "content-type": "application/json" },
        body: JSON.stringify({ text, ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}) }),
      });
      const json = await check(res, "creating a post");
      const id = json?.data?.id;
      if (typeof id !== "string") throw new XError(`X answered without a post id: ${JSON.stringify(json).slice(0, 200)}`);
      return id;
    },
    async metrics(ids) {
      if (ids.length === 0) return {};
      const url = `${API}/tweets?ids=${ids.join(",")}&tweet.fields=public_metrics`;
      const res = await fetch(url, { headers: { authorization: oauth1Header("GET", url, creds) } });
      const json = await check(res, "reading metrics");
      return Object.fromEntries(((json?.data ?? []) as { id: string; public_metrics: PublicMetrics }[]).map((t) => [t.id, t.public_metrics]));
    },
  };
}
