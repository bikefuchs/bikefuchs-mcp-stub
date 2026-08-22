// B-345 — shared honest-404 for discovery paths.
//
// WHY: the app/[...transport] catch-all routes every otherwise-unmatched path
// to the MCP SDK's Streamable-HTTP transport. For a plain GET that returns 406
// ("Client must accept text/event-stream"); for a GET carrying
// `Accept: text/event-stream` it opens an SSE stream that never closes and is
// killed by Vercel after 300s (504) — a real Active-CPU cost, not just a wrong
// status. See B345_DISCOVERY_FINDINGS.md.
//
// FIX SHAPE: the route files that import this win over the catch-all by Next.js
// routing precedence, so the SDK/SSE handler is never reached — for ANY method
// or Accept header. We answer an honest 404 because this server implements no
// OAuth (authorization is OPTIONAL in the MCP 2025-06-18 spec) and defines no
// document at these agent-directory paths. Content-bearing discovery lives at
// /.well-known/mcp/server-card.json (unchanged, still 200).
import { NextResponse } from "next/server";

export function discoveryNotFound() {
  return NextResponse.json(
    { error: "not_found" },
    {
      status: 404,
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
