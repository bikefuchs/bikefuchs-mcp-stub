import type { NextRequest } from "next/server";
import { handle } from "../lib/mcpServer";

// Default endpoint — exposes all 10 shops. Behavior is UNCHANGED; the feed-only
// variant lives at /mcp/openai (see app/mcp/openai/route.ts).
export function GET(req: NextRequest) {
  return handle(req, { feedOnly: false });
}
export function POST(req: NextRequest) {
  return handle(req, { feedOnly: false });
}
export function DELETE(req: NextRequest) {
  return handle(req, { feedOnly: false });
}
