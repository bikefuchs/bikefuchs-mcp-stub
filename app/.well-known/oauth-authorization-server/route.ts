// B-345: explicit route — wins over the app/[...transport] catch-all so this
// path never reaches the SDK SSE handler (no 406 for plain GET, no 300s
// open-stream hang for Accept: text/event-stream). Honest 404: this server
// serves no document here. See app/lib/discoveryFallback.ts.
import { discoveryNotFound } from "@/app/lib/discoveryFallback";

export function GET() {
  return discoveryNotFound();
}
