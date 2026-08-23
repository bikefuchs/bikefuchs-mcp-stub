// B-345b: catch-all for every UNKNOWN path under /mcp/.well-known/. Crawlers
// request discovery paths under both the host root and the /mcp/ base path, so
// this mirrors app/.well-known/[...slug] one level down.
//
// It is MORE SPECIFIC than the root app/[...transport] catch-all (literal `mcp`
// + `.well-known` prefix segments), so every /mcp/.well-known/* path is routed
// here before the transport — honest 404, for ANY method/Accept, no SSE hang.
//
// It does NOT create an app/mcp/route.ts, so bare /mcp (the POST Streamable-HTTP
// transport) still routes to app/[...transport] exactly as before. /mcp/openai
// keeps its own explicit route.
import { discoveryNotFound } from "@/app/lib/discoveryFallback";

export function GET() {
  return discoveryNotFound();
}
