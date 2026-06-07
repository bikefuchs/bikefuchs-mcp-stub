/**
 * Anti-harvesting rate-limit core (Chokepoint 2 — MCP stub).
 *
 * Mirrors the main-app limiter: two layers keyed by inbound IP —
 *   1. Burst cap   — 60 requests / minute / source (sliding window).
 *   2. Coverage cap — distinct product EANs served / source over 24h, via an
 *      Upstash HyperLogLog; catches slow enumeration. PFCOUNT logged for tuning.
 *
 * Redis is initialised EXPLICITLY from KV_REST_API_URL / KV_REST_API_TOKEN
 * (the Vercel–Upstash integration uses KV_*, not UPSTASH_*). FAIL OPEN if either
 * is absent. The read-only token is not used (we must write).
 */

import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;

export const RL_ENABLED = Boolean(url && token);

const redis = RL_ENABLED ? new Redis({ url: url!, token: token! }) : null;

const BURST_PER_MIN = 60;
export const COVERAGE_CAP = Number(process.env.COVERAGE_CAP ?? 500);
const COVERAGE_TTL_SECONDS = 24 * 60 * 60;

const burst = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(BURST_PER_MIN, '60 s'),
      prefix: 'bf:burst',
      analytics: false,
    })
  : null;

const covKey = (source: string) => `bf:cov:${source}`;

export type LimitDecision =
  | { ok: true }
  | { ok: false; reason: 'burst' | 'coverage'; retryAfter: number };

export async function checkLimits(source: string): Promise<LimitDecision> {
  if (!redis || !burst) return { ok: true }; // fail-open
  try {
    const count = await redis.pfcount(covKey(source));
    if (count >= COVERAGE_CAP) {
      return { ok: false, reason: 'coverage', retryAfter: 3600 };
    }
    const r = await burst.limit(source);
    if (!r.success) {
      const retryAfter = Math.max(1, Math.ceil((r.reset - Date.now()) / 1000));
      return { ok: false, reason: 'burst', retryAfter };
    }
    return { ok: true };
  } catch {
    return { ok: true }; // fail-open on Redis error
  }
}

export async function recordCoverage(
  source: string,
  eans: Array<string | null | undefined>
): Promise<void> {
  if (!redis) return;
  const clean = [...new Set(eans.filter((e): e is string => !!e && /^\d{8,14}$/.test(e)))];
  if (clean.length === 0) return;
  try {
    const key = covKey(source);
    const p = redis.pipeline();
    p.pfadd(key, ...clean);
    p.expire(key, COVERAGE_TTL_SECONDS);
    p.pfcount(key);
    const res = await p.exec();
    const count = res[res.length - 1];
    console.info(`[ratelimit] coverage source=${source}: ${count} distinct EANs (cap ${COVERAGE_CAP})`);
  } catch {
    /* best-effort */
  }
}

/** First inbound IP from Vercel/standard forwarding headers. */
export function clientIp(headers: Headers): string {
  const fwd =
    headers.get('x-vercel-forwarded-for') ??
    headers.get('x-forwarded-for') ??
    '';
  return fwd.split(',')[0].trim() || 'unknown';
}

/** Header used to pass the resolved source key from middleware → route handler. */
export const RL_SOURCE_HEADER = 'x-bf-rl-source';

/**
 * Recursively collect EAN-like values from an MCP tool result's structuredContent:
 * any string property named "ean", and any string entries in an "eans" array.
 * Covers search_product (results[].ean), get_best_price / find_alternatives /
 * resolve_product (top-level ean), and optimize_cart (shops_used[].items[].ean).
 */
export function extractEansFromMcp(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const v of node) extractEansFromMcp(v, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'ean' && typeof v === 'string') out.push(v);
      else if (k === 'eans' && Array.isArray(v)) {
        for (const e of v) if (typeof e === 'string') out.push(e);
      } else {
        extractEansFromMcp(v, out);
      }
    }
  }
  return out;
}
