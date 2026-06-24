import { NextResponse } from "next/server";
import { buildServerCard, CARD_HEADERS } from "../../../../lib/serverCard";

// Feed-only 8-shop server card for the /mcp/openai endpoint.
// Served at /.well-known/mcp/openai/server-card.json. Its transport.endpoint
// points at https://mcp.bikefuchs.com/mcp/openai. The 2 scraping shops are
// never named or counted here.
const SERVER_CARD = buildServerCard(true);

export function GET() {
  return NextResponse.json(SERVER_CARD, { headers: CARD_HEADERS });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
