import { createHmac, randomBytes } from "node:crypto";

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/** RFC 3986 percent-encoding, as OAuth 1.0a requires (stricter than encodeURIComponent). */
export const percentEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Authorization header for an OAuth 1.0a user-context request (RFC 5849, HMAC-SHA1).
 * `params` are the query and form parameters; a JSON body is not part of the signature.
 */
export function oauth1Header(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  params: Record<string, string> = {},
  nonce = randomBytes(16).toString("hex"),
  timestamp = Math.floor(Date.now() / 1000).toString(),
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const u = new URL(url);
  const all: [string, string][] = [...Object.entries(oauth), ...Object.entries(params), ...u.searchParams.entries()];
  const paramString = all
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const base = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join("&");
  const key = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.tokenSecret)}`;
  const signature = createHmac("sha1", key).update(base).digest("base64");
  return (
    "OAuth " +
    Object.entries({ ...oauth, oauth_signature: signature })
      .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
      .join(", ")
  );
}
