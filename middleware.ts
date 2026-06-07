/**
 * Chokepoint 2 — anti-harvesting gate for the MCP transport endpoints
 * (/mcp and /mcp/openai). Keyed by the REAL inbound IP.
 *
 * - SKIP both limits for AI egress ranges (OpenAI + Anthropic) — those are shared
 *   across many users; per-IP limiting them would collectively throttle legit
 *   ChatGPT/Claude traffic. Direct/datacenter crawlers use their own IPs and are
 *   limited normally.
 * - Otherwise apply burst (60/min) + coverage (distinct EANs/24h) caps.
 * - On limit: graceful JSON-RPC tool result with isError (German message), NOT a
 *   block page — so the AI client backs off instead of seeing a transport error.
 * - Coverage RECORDING (PFADD of served EANs) happens in the route handler
 *   (app/lib/mcpServer.ts handle()), which sees the response body; here we only
 *   gate and forward the source key.
 * - Fails OPEN when KV_* is unset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkLimits, clientIp, RL_SOURCE_HEADER } from './app/lib/rateLimit';
import { isAiEgress } from './app/lib/aiEgressCidrs';

export const config = {
  matcher: ['/mcp', '/mcp/openai'],
};

const THROTTLE_TEXT =
  'Zu viele Anfragen — bitte einen Moment warten und erneut versuchen.';

export async function middleware(req: NextRequest) {
  const source = clientIp(req.headers);

  // Allowlisted AI egress: skip both limits entirely (no key → no recording).
  if (isAiEgress(source)) {
    return NextResponse.next();
  }

  const decision = await checkLimits(source);

  if (!decision.ok) {
    // Graceful MCP tool-error result. Recover the JSON-RPC id from the body so
    // the client correlates the response; fall back to null on non-JSON/GET.
    let id: unknown = null;
    try {
      const body = await req.json();
      id = (body as { id?: unknown })?.id ?? null;
    } catch {
      id = null;
    }
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: THROTTLE_TEXT }],
          isError: true,
        },
      },
      { status: 200, headers: { 'Retry-After': String(decision.retryAfter) } }
    );
  }

  const headers = new Headers(req.headers);
  headers.set(RL_SOURCE_HEADER, source);
  return NextResponse.next({ request: { headers } });
}
