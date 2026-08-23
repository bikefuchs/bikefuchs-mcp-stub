// B-345b: catch-all for every UNKNOWN path under /.well-known/ at the host root.
//
// Replaces the ten hand-enumerated discovery routes (B-345) — production proved
// enumeration cannot keep up: new discovery paths (glama.json, owners.json,
// x402, oauth-protected-resource/mcp, …) keep appearing and fall through to the
// root app/[...transport] catch-all → the MCP SDK SSE handler (406 for a plain
// GET; a 300s-timeout open stream for Accept: text/event-stream).
//
// This nested catch-all is MORE SPECIFIC than the root [...transport] (it has a
// literal `.well-known` prefix segment), so Next.js routing precedence routes
// every /.well-known/* path here BEFORE the transport — for ANY method/Accept.
// More-specific static routes still win over THIS one, so the real discovery
// documents are untouched:
//   /.well-known/mcp/server-card.json          -> 200 (unchanged)
//   /.well-known/mcp/openai/server-card.json   -> 200 (unchanged)
//   /.well-known/openai-apps-challenge         -> 200 static (public/, wins over app routes)
//
// Honest 404: this server implements no OAuth (authorization is OPTIONAL in the
// MCP 2025-06-18 spec) and defines no document at these agent-directory paths.
// Per RFC 9728 §3.1 the correct protected-resource metadata URL for a resource
// at /mcp is the ROOT suffix form /.well-known/oauth-protected-resource/mcp —
// which this catch-all also covers (with 404), as we serve no such metadata.
import { discoveryNotFound } from "@/app/lib/discoveryFallback";

export function GET() {
  return discoveryNotFound();
}
