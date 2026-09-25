// B-492: /mcp card is generated from the server; the /mcp/openai card (serverCard.ts) stays hand-written on purpose (OpenAI review).
// B-492: the /mcp server card, generated from the stub's OWN server at build time.
//
// tools, protocolVersion and capabilities come from an in-process tools/list and
// initialize on the /mcp profile (inProcessMcpResult), serverInfo from SERVER_INFO —
// so the card always describes exactly what the server registers. Only the fields
// below that the server does not know about are hand-written; they match the card
// on bikefuchs.com.
//
// Scope: the /mcp card only. The /mcp/openai card stays hand-written in serverCard.ts,
// whose strings OpenAI froze at review time.
import { inProcessMcpResult, SERVER_INFO } from "./mcpServer";

const CARD_PROFILE = { feedOnly: false } as const;

export async function buildGeneratedServerCard() {
  const init = await inProcessMcpResult(CARD_PROFILE, {
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "b492-server-card", version: "0" } },
  });
  const list = await inProcessMcpResult(CARD_PROFILE, { method: "tools/list" });
  if (!Array.isArray(list.tools) || list.tools.length === 0) {
    throw new Error(`B-492: in-process tools/list returned no tools: ${JSON.stringify(list)}`);
  }
  if (typeof init.protocolVersion !== "string" || !init.capabilities) {
    throw new Error(`B-492: in-process initialize is incomplete: ${JSON.stringify(init)}`);
  }

  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
    version: "1.0",
    protocolVersion: init.protocolVersion,
    serverInfo: { ...SERVER_INFO, title: "Bikefuchs — Fahrradteile Preisvergleich" },
    description:
      "Compare prices for bicycle parts, components, accessories, and cycling clothing across German and Austrian bike shops. Optimize multi-product shopping carts to minimize total cost including shipping. Covers over 100,000 products. Supports DE and AT markets. Call get_shop_info for the current list of supported shops.",
    iconUrl: "https://bikefuchs.com/favicon.ico",
    documentationUrl: "https://bikefuchs.com/mcp",
    transport: { type: "streamable-http", endpoint: "https://mcp.bikefuchs.com/mcp" },
    capabilities: init.capabilities,
    authentication: { required: false, schemes: [] },
    instructions:
      "Search with plain keywords via search_product (e.g. 'shimano deore kette 12-fach') — no shop URL is needed. Use get_best_price for the price of a known EAN/GTIN at every shop, optimize_cart to find the cheapest shop combination for several EANs including shipping costs and free-shipping thresholds, find_alternatives_for_product to see which shops carry an EAN, get_shipping_breakdown for the exact shipping cost of one shop, get_shop_info for an overview of all shops, and resolve_product only when you already have a shop URL (it turns the URL into an EAN).",
    tools: list.tools,
  };
}
