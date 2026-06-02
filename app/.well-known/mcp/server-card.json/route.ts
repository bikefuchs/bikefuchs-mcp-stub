import { NextResponse } from "next/server";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=3600",
};

const SERVER_CARD = {
  $schema: "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
  version: "1.0",
  protocolVersion: "2025-06-18",
  serverInfo: {
    name: "bikefuchs",
    title: "Bikefuchs — Fahrradteile Preisvergleich",
    version: "2.5.0",
  },
  description:
    "Compare prices for bicycle parts, components, accessories, and cycling clothing across 10 German and Austrian bike shops. Optimize multi-product shopping carts to minimize total cost including shipping. Covers ~120,000 products from BOC24, Fahrrad24, ROSE Bikes, fahrrad-teile.shop, Bike Mailorder, Maciag Offroad, HiBike, BIKE24, Bike-Discount, and bike-components. Supports DE and AT markets.",
  iconUrl: "https://bikefuchs.com/favicon.ico",
  documentationUrl: "https://bikefuchs.com/mcp",
  transport: {
    type: "streamable-http",
    endpoint: "https://mcp.bikefuchs.com/mcp",
  },
  capabilities: { tools: {} },
  authentication: { required: false, schemes: [] },
  instructions:
    "Bikefuchs is a bicycle parts price comparison and cart optimization service for German and Austrian cyclists. Use search_product for text search, get_best_price for EAN/GTIN lookup, optimize_cart for multi-product cart optimization with shipping cost minimization, get_shop_info for shop overview, get_shipping_breakdown for shipping cost details, find_alternatives_for_product to check which shops carry a product, and resolve_product to turn a product page URL into a comparable product.",
  tools: [
    {
      name: "search_product",
      title: "Search Products",
      description:
        "Find and compare prices for bicycle parts, components, accessories, and cycling clothing across 10 German and Austrian bike shops. Search by product name, brand, or model number. Returns real-time prices, stock availability, and direct purchase links. Covers MTB, road bike, gravel, e-bike, and city bike parts.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Search query (product name, brand, model number)" },
          max_results: { type: "number", description: "Maximum number of results (default: 10, max: 20)" },
        },
        required: ["q"],
      },
    },
    {
      name: "get_best_price",
      title: "Get Best Price",
      description:
        "Look up a specific bicycle product by its EAN/GTIN barcode number and find the best price across all 10 shops. Returns prices from every shop that carries the product, sorted cheapest first, with stock status and affiliate purchase links.",
      inputSchema: {
        type: "object",
        properties: {
          ean: { type: "string", description: "EAN/GTIN barcode (8-14 digits)" },
        },
        required: ["ean"],
      },
    },
    {
      name: "optimize_cart",
      title: "Optimize Shopping Cart",
      description:
        "Optimize a shopping cart of bicycle products across multiple shops to find the cheapest total cost including shipping. Provide product URLs from supported shops and get the optimal shop combination that minimizes total spend. Accounts for per-shop shipping costs, free-shipping thresholds, and country-specific pricing (DE/AT).",
      inputSchema: {
        type: "object",
        properties: {
          urls: {
            type: "array",
            items: { type: "string" },
            description: "Array of product URLs from supported bike shops",
          },
          country: { type: "string", enum: ["DE", "AT"], description: "Destination country (default: DE)" },
        },
        required: ["urls"],
      },
    },
    {
      name: "get_shop_info",
      title: "Shop Information",
      description:
        "Get an overview of all supported bike shops in the Bikefuchs network, including shipping cost tiers, free-shipping thresholds, and supported countries (Germany and Austria).",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_shipping_breakdown",
      title: "Shipping Cost Breakdown",
      description:
        "Get the exact shipping cost for a specific shop, country, and cart value. Returns the shipping fee, free-shipping threshold, and whether the order qualifies for free shipping.",
      inputSchema: {
        type: "object",
        properties: {
          shop: { type: "string", description: "Shop identifier (e.g., 'bike24', 'rosebikes')" },
          country: { type: "string", enum: ["DE", "AT"], description: "Destination country" },
          cart_value: { type: "number", description: "Total cart value in EUR" },
        },
        required: ["shop", "country", "cart_value"],
      },
    },
    {
      name: "find_alternatives_for_product",
      title: "Find Alternatives",
      description:
        "Discover which shops carry a specific product by EAN barcode, sorted by price. Use when a user found a product at one shop and wants to know if it's available cheaper elsewhere.",
      inputSchema: {
        type: "object",
        properties: {
          ean: { type: "string", description: "EAN/GTIN barcode (8-14 digits)" },
        },
        required: ["ean"],
      },
    },
    {
      name: "resolve_product",
      title: "Resolve Product URL",
      description:
        "Resolve a bicycle product page URL from a supported shop into structured product data, including the product's EAN/GTIN, so it can then be price-compared across all shops. Use when a user pastes a product link.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Product page URL from a supported shop (e.g. 'https://www.bike24.de/p2462871.html')",
          },
          country: { type: "string", enum: ["DE", "AT"], description: "Country for pricing (DE or AT, default DE)" },
        },
        required: ["url"],
      },
    },
  ],
};

export function GET() {
  return NextResponse.json(SERVER_CARD, { headers: HEADERS });
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
