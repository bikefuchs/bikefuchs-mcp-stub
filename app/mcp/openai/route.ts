import type { NextRequest } from "next/server";
import { handle } from "../../lib/mcpServer";

// Feed-only MCP endpoint at /mcp/openai — exposes ONLY the 8 authorized feed
// shops and never reveals or counts the 2 scraping shops (BIKE24, Bike-Discount).
// Same server logic as /mcp, with feedOnly=true.
//
// renderProfile: 'openai' makes the shared builder emit /go/ links as BARE
// plain-text https:// URLs (ChatGPT does not reliably render markdown links
// from tool-result text). /mcp passes no renderProfile → defaults to 'claude'
// (markdown links, byte-for-byte unchanged). feedOnly and renderProfile are
// independent concepts and never key off each other.
//
// Route precedence: this is a static route (segments "mcp" + "openai"). Next.js
// resolves static segments before the root optional/dynamic catch-all
// (app/[...transport]/route.ts), so requests to /mcp/openai land here while
// /mcp (and every other path) continues to hit the catch-all unchanged.
export function GET(req: NextRequest) {
  return handle(req, { feedOnly: true, renderProfile: 'openai' });
}
export function POST(req: NextRequest) {
  return handle(req, { feedOnly: true, renderProfile: 'openai' });
}
export function DELETE(req: NextRequest) {
  return handle(req, { feedOnly: true, renderProfile: 'openai' });
}
