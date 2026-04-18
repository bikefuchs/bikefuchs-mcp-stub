import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { NextRequest } from "next/server";

const INFO_TEXT =
  "Bikefuchs MCP launches Q3 2026. This is a placeholder server reserving the @bikefuchs namespace on Smithery. Real functionality (optimize_cart, search_product, find_by_ean, get_shop_info) will be available after the public launch on bikefuchs.de. For current bike price comparison across 5+ German/Austrian bike shops, visit https://bikefuchs.de";

function createServer() {
  const server = new McpServer({ name: "bikefuchs-stub", version: "0.1.0" });
  server.tool(
    "get_info",
    "Returns basic information about the Bikefuchs MCP server, including launch status and a link to the Bikefuchs website. Call this tool to learn what Bikefuchs offers and when the full MCP functionality will be available.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: INFO_TEXT }],
    })
  );
  return server;
}

async function handle(req: NextRequest): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createServer();
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as GET, handle as POST, handle as DELETE };
