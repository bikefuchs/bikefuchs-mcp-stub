import { NextResponse } from "next/server";
import { buildGeneratedServerCard } from "../../../lib/generatedServerCard";

// B-492: the /mcp server card is generated from the server's own tools/list and
// initialize (app/lib/generatedServerCard.ts) and prerendered at build time — a
// static file, no network call and no per-request work. A failure in the in-process
// build throws here and fails `next build`; there is deliberately no fallback card.
export const dynamic = "force-static";

// No OPTIONS export: in Next 15 any non-GET handler makes the route dynamic. Next
// answers OPTIONS itself, and the CORS headers (unchanged from the hand-written
// card) are set for this path in next.config.js headers(), which covers GET and
// OPTIONS alike — set there only, so no response carries them twice.
export async function GET() {
  return NextResponse.json(await buildGeneratedServerCard(), {
    headers: { "Content-Type": "application/json" },
  });
}
