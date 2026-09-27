/**
 * B-497 Step 1 — route-handler rate-limit gate (behind B497_LIMIT_IN_HANDLER, default
 * off). Reproduces middleware.ts's Chokepoint 2 gate exactly, standalone, so it does
 * NOT depend on anything middleware.ts does (a later step deletes middleware.ts
 * entirely and flips this flag on in the same deployment). THROTTLE_TEXT is
 * duplicated verbatim from middleware.ts rather than imported — this file must never
 * import from middleware.ts.
 *
 * Call from mcpServer.ts's handle(), after b477EarlyExit and before building the
 * transport/server: if `response` is non-null, return it immediately. Otherwise use
 * `source` for recordCoverage — it is deliberately null whenever the corresponding
 * middleware path would never have set RL_SOURCE_HEADER (method-gated, AI-egress,
 * flagged-probe), so "no key → no recording" is preserved exactly.
 */

import type { NextRequest } from 'next/server';
import { checkLimits, clientIp } from './rateLimit';
import { isAiEgress } from './aiEgressCidrs';
import { isProbeEgress } from './probeCidrs';

const THROTTLE_TEXT =
  'Zu viele Anfragen — bitte einen Moment warten und erneut versuchen.';

export async function handlerLimitGate(
  req: NextRequest,
): Promise<{ response: Response | null; source: string | null }> {
  // B-364: method gate (flag-gated, OFF unless the env var is exactly "true"). Mirrors
  // middleware.ts:42-48 — read inside the function body, never at module scope.
  if (
    process.env.B364_METHOD_GATE_ENABLED === 'true' &&
    req.method !== 'POST' &&
    req.method !== 'DELETE'
  ) {
    console.info(`[B497] hl result=skip-method method=${req.method}`);
    return { response: null, source: null };
  }

  const source = clientIp(req.headers);

  // Allowlisted AI egress: skip both limits entirely (no key → no recording).
  // Mirrors middleware.ts:52-55.
  if (isAiEgress(source)) {
    console.info(`[B497] hl result=skip-ai method=${req.method}`);
    return { response: null, source: null };
  }

  // B-366: known MCP health probes (handshake-only, never harvest an EAN) — mirrors
  // middleware.ts:57-74 exactly, incl. the shadow log line. The match is computed
  // unconditionally in both flag states so the shadow count stays complete; the flag
  // controls ONLY whether the early return is taken. Read inside the function body.
  const isProbe = isProbeEgress(source);
  if (isProbe) {
    const probeFlagOn = process.env.B366_PROBE_ALLOWLIST_ENABLED === 'true';
    console.info(
      `[MW] B366 probe: ip=${source} match=true flag=${probeFlagOn ? 'on' : 'off'} applied=${probeFlagOn ? 'skipped' : 'limited'} ${probeFlagOn ? 'B366_SKIP_APPLIED' : 'B366_SKIP_SHADOW'}`,
    );
    if (probeFlagOn) {
      console.info(`[B497] hl result=probe-skip method=${req.method}`);
      return { response: null, source: null };
    }
  }

  const decision = await checkLimits(source);

  if (!decision.ok) {
    // Graceful MCP tool-error result, mirrors middleware.ts:78-98. Recover the
    // JSON-RPC id from a CLONE of the body — never req.json() directly, since the
    // original request must still be readable by the caller's subsequent
    // transport.handleRequest(req) when this gate does NOT short-circuit. (This
    // branch always short-circuits, but the clone keeps the pattern uniform and
    // matches the repo's existing precedent for pre-dispatch body reads, e.g. the
    // B-365 diagnostic's diagPostReq clone in handle().)
    let id: unknown = null;
    try {
      const body = await req.clone().json();
      id = (body as { id?: unknown })?.id ?? null;
    } catch {
      id = null;
    }
    console.info(`[B497] hl result=limited-${decision.reason} method=${req.method}`);
    return {
      response: new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: THROTTLE_TEXT }],
            isError: true,
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(decision.retryAfter),
          },
        },
      ),
      source,
    };
  }

  console.info(`[B497] hl result=allowed method=${req.method}`);
  return { response: null, source };
}
