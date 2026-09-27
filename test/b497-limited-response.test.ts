/**
 * B-497 Step 1 — "limited" throttle-response shape.
 *
 * This file needs KV_REST_API_URL / KV_REST_API_TOKEN to be non-empty BEFORE
 * app/lib/rateLimit.ts's module-scope `redis`/`burst` singletons are constructed
 * (app/lib/rateLimit.ts:17-35) — that decision is made once, at module import time,
 * and cached for the life of the process (ESM modules are singletons). It therefore
 * CANNOT share a process with test/b497-handler-limit.test.ts, which relies on KV_*
 * being UNSET (the natural, secret-free local/CI state) to exercise checkLimits'
 * fail-open path. Hence its own npm script (test:b497-limited) sets these two env
 * vars for the whole process before node even starts, and its own `node --test`
 * invocation — see package.json.
 *
 * globalThis.fetch (a plain, configurable global — unlike an ES module's named
 * exports, which cannot be reassigned or reconfigured from outside the defining
 * module) is stubbed for the one Upstash command this file needs: `redis.pfcount()`
 * (app/lib/rateLimit.ts:81, `redis.pfcount(covKey(source))`). The installed
 * @upstash/redis (1.38.0) auto-pipelines even a single, standalone command — verified
 * empirically (not from docs) by probing checkLimits() with a diagnostic fetch stub:
 * it POSTs to `<baseUrl>/pipeline` with body `[["pfcount", key]]` (an array of
 * command-arrays) and expects an array of `{result}` objects back, one per command,
 * NOT the flat `{result: N}` shape a non-pipelined single command would use. The stub
 * below returns a count above COVERAGE_CAP for that one command, so checkLimits'
 * SEQUENTIAL path (the default here — B368_PARALLEL_LIMITS_ENABLED is unset in this
 * process) returns {ok:false, reason:'coverage', retryAfter:3600} without ever
 * reaching burst.limit()'s sliding-window Lua script.
 *
 * DEVIATION from the task prompt: that script's exact Upstash wire protocol
 * (EVALSHA/EVAL, script hash, response shape) is undocumented and version-specific
 * (@upstash/ratelimit 2.x against @upstash/redis 1.38.0 in this lockfile) — faking it
 * byte-correctly without a live-compatible backend was judged too fragile to be
 * worth the risk of a subtly-wrong stub. So the BURST-limited reason is not
 * exercised here, only the COVERAGE-limited one. The response-BUILDING code in
 * app/lib/handlerLimit.ts is identical for both reasons except the interpolated
 * `decision.reason` string and `decision.retryAfter` number, both of which are typed
 * fields of rateLimit.ts's LimitDecision consumed as-is (not re-derived), so this is
 * still a real exercise of the field-by-field response shape middleware.ts produces.
 *
 * Run: npm run test:b497-limited
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import { handlerLimitGate } from '../app/lib/handlerLimit';

if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  throw new Error(
    'test/b497-limited-response.test.ts requires KV_REST_API_URL and KV_REST_API_TOKEN to be set BEFORE ' +
      'this process starts (rateLimit.ts constructs its Redis/Ratelimit singletons at module-scope import ' +
      'time) — run it via `npm run test:b497-limited`, not directly.',
  );
}

// Verbatim from middleware.ts's THROTTLE_TEXT (do not translate/paraphrase).
const THROTTLE_TEXT = 'Zu viele Anfragen — bitte einen Moment warten und erneut versuchen.';

function stubPfcountHigh(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    let commands: unknown[];
    try {
      const parsed = JSON.parse(bodyText);
      // Auto-pipelined request: an array of command-arrays, e.g. [["pfcount", key]].
      commands = Array.isArray(parsed) ? parsed : [];
    } catch {
      commands = [];
    }
    if (commands.length > 0 && commands.every((c) => Array.isArray(c) && String(c[0]).toLowerCase() === 'pfcount')) {
      return new Response(JSON.stringify(commands.map(() => ({ result: 10_000 }))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Any other command means the sequential short-circuit didn't happen as expected
    // (e.g. burst.limit() got reached) — fail loudly rather than silently mis-stub.
    throw new Error(`b497-limited-response stub: unexpected Upstash request body: ${bodyText}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeRequest(body: unknown, headers: Record<string, string>, method = 'POST'): Request {
  return new Request('https://mcp.bikefuchs.com/mcp', {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

test('[7b] checkLimits coverage-limited → handlerLimitGate returns the middleware-shaped throttle response', async () => {
  const restore = stubPfcountHigh();
  const originalInfo = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    const req = makeRequest(
      { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'search_product', arguments: {} } },
      { 'x-vercel-forwarded-for': '203.0.113.30' },
    );
    const result = await handlerLimitGate(req as unknown as NextRequest);
    assert.ok(result.response, 'expected a throttle response, got null (not limited)');
    const res = result.response!;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('retry-after'), '3600');
    const body = await res.json();
    assert.deepEqual(body, {
      jsonrpc: '2.0',
      id: 42,
      result: { content: [{ type: 'text', text: THROTTLE_TEXT }], isError: true },
    });
    assert.deepEqual(
      lines.filter((l) => l.startsWith('[B497]')),
      ['[B497] hl result=limited-coverage method=POST'],
    );
  } finally {
    console.info = originalInfo;
    restore();
  }
});

test('[7b] id falls back to null when the body is not JSON (mirrors middleware.ts:79-87)', async () => {
  const restore = stubPfcountHigh();
  try {
    const req = makeRequest(null, { 'x-vercel-forwarded-for': '203.0.113.31' }, 'GET');
    const result = await handlerLimitGate(req as unknown as NextRequest);
    assert.ok(result.response, 'expected a throttle response, got null (not limited)');
    const body = (await result.response!.json()) as { id: unknown };
    assert.equal(body.id, null);
  } finally {
    restore();
  }
});
