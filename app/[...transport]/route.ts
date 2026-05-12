import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { NextRequest } from "next/server";
import { z } from "zod";

// Use www subdomain directly — bikefuchs.com (apex) 307-redirects to www
const API_BASE = process.env.BIKEFUCHS_API_URL ?? "https://www.bikefuchs.com";
const FETCH_TIMEOUT_MS = 8000;
const FOOTER =
  "\n\n---\n*Powered by [Bikefuchs](https://bikefuchs.com) — Bike price comparison for DE & AT*";

async function apiFetch(path: string, options?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(options?.headers);
    headers.set("Accept", "application/json");
    return await fetch(`${API_BASE}${path}`, { ...options, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function apiJson<T>(path: string, options?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  const res = await apiFetch(path, options, timeoutMs);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const body = await res.text();
    console.error(`[MCP] Non-JSON response from ${path}: ${contentType} — ${body.substring(0, 200)}`);
    throw new Error(`API returned unexpected content (${contentType || "unknown"}). The bikefuchs.com API may be temporarily unavailable.`);
  }
  return res.json() as Promise<T>;
}

function mcpText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const TOOL_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function createServer() {
  const server = new McpServer({ name: "bikefuchs", version: "1.0.0" });

  // ── Tool 1: search_product ─────────────────────────────────────────────────
  server.tool(
    "search_product",
    "Search for bicycle parts, components, accessories, and cycling clothing across 6 German/Austrian bike shops (BOC24, Fahrrad24, Rose Bikes, fahrrad-teile.shop, Bike Mailorder, Maciag Offroad) with ~120,000 products. Search by product name, brand, or model number. Returns real-time prices, stock availability, and direct purchase links sorted by price. Covers MTB, road bike, gravel, e-bike, and city bike parts including brands like Shimano, SRAM, Continental, Schwalbe, Magura, Bosch, Maxxis, and more. Supports German (DE) and Austrian (AT) markets with country-specific pricing. Use this when a user wants to find, compare, or buy bike parts at the best price. Fahrrad Teile Preisvergleich.",
    {
      q: z.string().min(2).describe("Search keyword, min 2 chars. Multi-word queries use AND logic across product name, description, and specifications (e.g. 'shimano xt bremsbeläge')"),
      country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
      in_stock: z.boolean().optional().default(true).describe("Only return in-stock products (default true)"),
      max_results: z.number().int().min(1).max(20).optional().default(10).describe("Max results (1–20, default 10)"),
      shop: z.enum(["boc24", "fahrrad24", "rosebikes", "fahrradteile", "bmo", "maciag"]).optional().describe("Restrict results to a single shop"),
      max_price: z.number().positive().optional().describe("Upper price bound in EUR (inclusive)"),
      category: z.string().optional().describe("Filter by merchant category (partial match, e.g. 'Fahrräder' or 'Bremsen')"),
    },
    { ...TOOL_HINTS, title: "Search Bike Products" },
    async ({ q, country, in_stock, max_results, shop, max_price, category }) => {
      console.info(`[MCP] search_product: q="${q}" country=${country} in_stock=${in_stock} max=${max_results}${shop ? ` shop=${shop}` : ''}${max_price !== undefined ? ` max_price=${max_price}` : ''}${category ? ` category=${category}` : ''}`);
      try {
        const params = new URLSearchParams({
          q,
          country,
          in_stock: String(in_stock),
          max_results: String(max_results),
        });
        if (shop) params.set('shop', shop);
        if (max_price !== undefined) params.set('max_price', String(max_price));
        if (category) params.set('category', category);
        const data = await apiJson<{ results?: ProductSearchResult[]; total?: number; error?: string }>(`/api/products/search?${params}`);

        if (!data.results || data.results.length === 0) {
          return mcpText(`No products found for "${q}" in ${country}.${FOOTER}`);
        }

        const lines = data.results.map((p, i) => {
          const stockIcon = p.in_stock ? "✅" : "❌";
          const link = p.purchase_url ?? p.product_url ?? "";
          return `${i + 1}. [${p.product_name} — ${p.shop}](${link}) — **€${p.price.toFixed(2)}** ${stockIcon}${p.ean ? ` · EAN ${p.ean}` : ""}`;
        });

        return mcpText(
          `## Product Search: "${q}" (${country})\n\nFound ${data.total} result(s):\n\n${lines.join("\n\n")}${FOOTER}`
        );
      } catch (err) {
        return mcpText(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 2: get_best_price ─────────────────────────────────────────────────
  server.tool(
    "get_best_price",
    "Look up a product by EAN barcode and find the best price across all feed shops (BOC24, Fahrrad24, Rose Bikes, fahrrad-teile.shop, Bike Mailorder, Maciag Offroad). Returns prices from every shop that carries the product, sorted cheapest first, with stock status and affiliate purchase links. Use this when you already know the exact product EAN (e.g., from a previous search result) and want to find the single cheapest price across all available shops.",
    {
      ean: z.string().regex(/^\d{8,14}$/).describe("EAN barcode (8–14 digits, e.g. '4524667749493')"),
      country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
    },
    { ...TOOL_HINTS, title: "Get Best Price by EAN" },
    async ({ ean, country }) => {
      console.info(`[MCP] get_best_price: ean=${ean} country=${country}`);
      try {
        const data = await apiJson<{ ean?: string; results?: EanResult[]; total?: number; cheapest?: EanResult | null; error?: string }>(`/api/products/${ean}?country=${country}`);

        if (!data.results || data.results.length === 0) {
          return mcpText(
            `No results found for EAN ${ean} in ${country}. The product may not be carried by any supported shop.${FOOTER}`
          );
        }

        const productName = data.cheapest?.product_name ?? "Product";
        const lines = data.results.map((r, i) => {
          const stockIcon = r.in_stock ? "✅" : "❌";
          const trophy = i === 0 ? " 🏆" : "";
          const link = r.purchase_url ?? r.product_url ?? "";
          return `${i + 1}. [${productName} — ${r.shop}](${link})${trophy} — **€${r.price.toFixed(2)}** ${stockIcon}`;
        });

        return mcpText(
          `## Best Price: ${productName}\n\nEAN: ${ean} · ${country}\n\n${lines.join("\n\n")}\n\n**Best price: €${data.cheapest!.price.toFixed(2)} at ${data.cheapest!.shop}**\n\n💡 To optimize a cart with this and other products, collect the EANs and call optimize_cart.${FOOTER}`
        );
      } catch (err) {
        return mcpText(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 3: optimize_cart ──────────────────────────────────────────────────
  server.tool(
    "optimize_cart",
    "Optimize a shopping cart of bicycle products across multiple shops to find the cheapest total cost including shipping. Provide EAN barcodes (from search_product or get_best_price results) and get the optimal shop combination that minimizes total spend. Accounts for per-shop shipping costs, free-shipping thresholds, and country-specific pricing (DE/AT). Covers 6 feed shops (BOC24, Fahrrad24, Rose Bikes, fahrrad-teile.shop, Bike Mailorder, Maciag Offroad) plus 3 scraping shops (BIKE24, Bike-Discount, bike-components) when cached. Use this when a user has multiple bike parts to buy and wants to know the cheapest way to split their order. Tip: call get_best_price or search_product first to warm the cache for scraping shops. Warenkorb optimieren Versandkosten.",
    {
      eans: z
        .array(z.string().regex(/^\d{8,14}$/, "Must be a numeric EAN (8–14 digits)"))
        .min(1)
        .max(20)
        .describe("EAN barcodes of the products to optimize (8–14 digits each, e.g. ['4524667749493', '4055205261677']). Get EANs from search_product or get_best_price results."),
      country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing and shipping (DE or AT, default DE)"),
    },
    { ...TOOL_HINTS, title: "Optimize Shopping Cart" },
    async ({ eans, country }) => {
      console.info(`[MCP] optimize_cart: ${eans.length} EAN(s) country=${country}`);
      try {
        const data = await apiJson<OptimizeFromEansResult>("/api/cart/optimize-from-eans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eans, country }),
        });

        if (!data.success || !data.result) {
          let msg = `Could not optimize cart: ${data.error ?? "No shops found for any of the provided EANs."}`;
          if (data.eans_skipped?.length) {
            msg += `\n\nSkipped EANs (no shops found): ${data.eans_skipped.join(", ")}`;
            msg += `\n\n💡 Call get_best_price for each EAN first to warm the cache for scraping shops.`;
          }
          return mcpText(msg + FOOTER);
        }

        const { result } = data;
        let md = `## Cart Optimization (${country})\n\n`;

        if (data.eans_skipped?.length) {
          md += `⚠️ No shops found for EAN(s): ${data.eans_skipped.join(", ")} — call get_best_price first to warm the cache.\n\n`;
        }

        md += `### Optimal Shop Split\n`;
        for (const order of result.orders) {
          md += `\n**${order.shopName}** — products €${order.subtotal.toFixed(2)} + shipping €${order.shippingCost.toFixed(2)} = €${order.total.toFixed(2)}\n`;
          for (const item of order.products) {
            md += `  - [${item.productName} — ${order.shopName}](${item.url}) — **€${item.price.toFixed(2)}**\n`;
          }
        }

        md += `\n**Total cost: €${result.totalCost.toFixed(2)}** (incl. €${result.totalShipping.toFixed(2)} shipping)`;
        if (result.savings !== null && result.savings > 0) {
          md += ` *(saves €${result.savings.toFixed(2)}${result.savingsPercent !== null ? ` / ${result.savingsPercent}%` : ""} vs. single shop)*`;
        }
        md += "\n";

        return mcpText(md + FOOTER);
      } catch (err) {
        return mcpText(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 4: get_shop_info ──────────────────────────────────────────────────
  server.tool(
    "get_shop_info",
    "Get an overview of all supported bike shops in the Bikefuchs network, including shipping cost tiers, free-shipping thresholds, and supported countries (Germany and Austria). Bikefuchs is a bicycle parts price comparison service covering ~120,000 products from 10 shops. Use this to answer questions about which shops are available, what shipping costs apply, or what Bikefuchs can do. Fahrrad Preisvergleich Deutschland Österreich.",
    {
      country: z
        .enum(["DE", "AT"])
        .optional()
        .describe("Filter output to a specific country (optional — omit for both DE and AT)"),
    },
    { ...TOOL_HINTS, title: "Get Shop Overview" },
    async ({ country }) => {
      console.info(`[MCP] get_shop_info country=${country ?? "all"}`);
      try {
        const data = await apiJson<{ shops?: Record<string, Record<string, ShippingCountryInfo>>; error?: string }>("/api/shops/shipping");

        const shops = data.shops ?? {};
        let md = `## Bikefuchs — Shop Shipping Overview\n\n`;

        for (const [shopName, countries] of Object.entries(shops)) {
          md += `### ${shopName}\n`;
          for (const [c, info] of Object.entries(countries)) {
            if (country && c !== country) continue;
            const freeAt =
              info.free_shipping_threshold !== null
                ? `Free from €${info.free_shipping_threshold}`
                : "No free shipping";
            const tiers = info.tiers
              .map((t) => `€${t.min_order_value}+: €${t.shipping_cost}`)
              .join(" | ");
            md += `- **${c}**: ${freeAt} — Tiers: ${tiers}\n`;
          }
          md += "\n";
        }

        return mcpText(md + FOOTER);
      } catch (err) {
        return mcpText(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 5: get_shipping_breakdown ────────────────────────────────────────
  server.tool(
    "get_shipping_breakdown",
    "Get the exact shipping cost for a specific shop, country, and cart value. Shows all shipping tiers and how close the cart is to the next free-shipping threshold. Use this when a user asks about shipping costs for a specific shop or wants to know how much more they need to spend to get free shipping.",
    {
      shop: z.string().describe("Shop name or ID (e.g. 'rosebikes', 'boc24', 'bike24', 'fahrradteile', 'Rose Bikes')"),
      country: z.enum(["DE", "AT"]).describe("Country (DE or AT)"),
      cart_value: z.number().min(0).describe("Total cart value in EUR (e.g. 49.99)"),
    },
    { ...TOOL_HINTS, title: "Get Shipping Cost" },
    async ({ shop, country, cart_value }) => {
      console.info(`[MCP] get_shipping_breakdown: shop="${shop}" country=${country} cart=€${cart_value}`);
      try {
        const params = new URLSearchParams({ shop, country, cart_value: String(cart_value) });
        const data = await apiJson<ShippingResult>(`/api/shops/shipping?${params}`);

        const total = (data.cart_value + data.shipping_cost).toFixed(2);
        let md = `## Shipping: ${data.shop} (${country})\n\n`;
        md += `- Cart value: €${data.cart_value.toFixed(2)}\n`;
        md += `- Shipping: €${data.shipping_cost.toFixed(2)}${data.is_free ? " **(FREE)**" : ""}\n`;
        md += `- **Total: €${total}**\n`;

        if (data.free_shipping_threshold !== null && !data.is_free) {
          const gap = (data.free_shipping_threshold - data.cart_value).toFixed(2);
          md += `\n💡 Add €${gap} more to reach free shipping (threshold: €${data.free_shipping_threshold})\n`;
        }

        md += `\n**Shipping tiers (${country}):**\n`;
        for (const tier of data.tiers) {
          const active = data.cart_value >= tier.min_order_value ? " ◀ current" : "";
          md += `- From €${tier.min_order_value}: €${tier.shipping_cost}${active}\n`;
        }

        return mcpText(md + FOOTER);
      } catch (err) {
        return mcpText(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 6: find_alternatives_for_product ────────────────────────────────
  server.tool(
    "find_alternatives_for_product",
    "Discover which shops carry a specific product by EAN barcode, sorted by price. Use this when a user found a product at one shop and wants to know if it's available cheaper elsewhere, or when a product is out of stock and the user needs an alternative source. Returns all shops that carry this EAN with prices and availability.",
    {
      ean: z.string().regex(/^\d{8,14}$/).describe("EAN barcode (8–14 digits, e.g. '4524667749493')"),
      country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
    },
    { ...TOOL_HINTS, title: "Find Alternative Shops" },
    async ({ ean, country }) => {
      console.info(`[MCP] find_alternatives_for_product: ean=${ean} country=${country}`);
      try {
        const data = await apiJson<{ ean?: string; results?: EanResult[]; total?: number; cheapest?: EanResult | null; error?: string }>(`/api/products/${ean}?country=${country}`);

        if (!data.results || data.results.length === 0) {
          return mcpText(
            `No shops found carrying EAN ${ean} in ${country}. The product may not be in any supported shop's feed.${FOOTER}`
          );
        }

        const productName = data.cheapest?.product_name ?? "Product";
        let md = `## Where to Buy: ${productName}\n\nEAN: ${ean} · ${country} · ${data.total} shop(s) carry this product\n\n`;

        for (let i = 0; i < data.results.length; i++) {
          const r = data.results[i];
          const stockIcon = r.in_stock ? "✅" : "❌";
          const trophy = i === 0 ? " 🏆" : "";
          const link = r.purchase_url ?? r.product_url ?? "";
          md += `${i + 1}. [${productName} — ${r.shop}](${link})${trophy} — **€${r.price.toFixed(2)}** ${stockIcon}\n`;
        }

        return mcpText(md + FOOTER);
      } catch (err) {
        return mcpText(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 7: resolve_product ───────────────────────────────────────────────
  server.tool(
    "resolve_product",
    "Resolve a bike shop product page URL into structured product data including the EAN barcode, price, stock status, and a purchase link. Use this when a user pastes a product URL from a supported shop and you need to extract the EAN (e.g. to then call get_best_price or optimize_cart). Supported shops: BIKE24 (bike24.de, bike24.at), BOC24 (boc24.de), Fahrrad24 (fahrrad24.de, velondo.at), Rose Bikes (rosebikes.de, rosebikes.at), fahrrad-teile.shop, Bike Mailorder (bike-mailorder.com, bike-mailorder.at), Maciag Offroad (maciag.de), Bike-Discount (bike-discount.de), bike-components (bike-components.de). Scraping shops (BIKE24, Bike-Discount, bike-components) may take up to 12 seconds on first load.",
    {
      url: z.string().url().describe("Product page URL from a supported shop (e.g. 'https://www.bike24.de/p2462871.html')"),
      country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
    },
    { ...TOOL_HINTS, title: "Resolve Product URL" },
    async ({ url, country }) => {
      console.info(`[MCP] resolve_product: url=${url} country=${country}`);
      try {
        const data = await apiJson<ResolveResult>("/api/products/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, country }),
        }, 25000);

        if (data.error) {
          return mcpText(`Could not resolve product: ${data.error}${FOOTER}`);
        }

        const stockIcon = data.in_stock ? "✅ In stock" : "❌ Out of stock";
        const link = data.purchase_url ?? data.product_url ?? url;
        let md = `## Resolved Product\n\n`;
        md += `[${data.product_name ?? "Product"} — ${data.shop}](${link}) — **€${data.price.toFixed(2)}** ${stockIcon}\n\n`;
        if (data.ean) {
          md += `**EAN:** ${data.ean}\n\n`;
          md += `💡 Use this EAN with get_best_price to compare prices across all shops, or collect EANs and call optimize_cart to minimize your total cart cost.`;
        } else {
          md += `⚠️ No EAN found for this product — price comparison may not be available.`;
        }

        return mcpText(md + FOOTER);
      } catch (err) {
        return mcpText(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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

// ── Type definitions ──────────────────────────────────────────────────────────

interface ProductSearchResult {
  ean: string | null;
  product_name: string;
  brand: string | null;
  price: number;
  shop: string;
  shop_id: string;
  in_stock: boolean;
  purchase_url: string | null;
  product_url: string | null;
  affiliate_link: string | null;
  image_url: string | null;
}

interface EanResult {
  shop: string;
  shop_id: string;
  ean: string;
  product_name: string;
  brand: string | null;
  price: number;
  in_stock: boolean;
  purchase_url: string | null;
  product_url: string | null;
  affiliate_link: string | null;
  image_url: string | null;
}

interface ShippingTier {
  min_order_value: number;
  shipping_cost: number;
}

interface ShippingCountryInfo {
  tiers: ShippingTier[];
  free_shipping_threshold: number | null;
}

interface ShippingResult {
  shop: string;
  country: string;
  cart_value: number;
  shipping_cost: number;
  is_free: boolean;
  free_shipping_threshold: number | null;
  tiers: ShippingTier[];
  error?: string;
}

interface ShopOrderItem {
  productName: string;
  shopName: string;
  price: number;
  url: string;
  inStock: boolean;
}

interface ShopOrder {
  shopName: string;
  products: ShopOrderItem[];
  subtotal: number;
  shippingCost: number;
  total: number;
}

interface OptimizationResult {
  orders: ShopOrder[];
  totalCost: number;
  totalShipping: number;
  savings: number | null;
  savingsPercent: number | null;
}

interface OptimizeFromEansResult {
  success: boolean;
  country: string;
  eans_requested: string[];
  eans_resolved: string[];
  eans_skipped: string[];
  result: OptimizationResult | null;
  error?: string;
}

interface ResolveResult {
  ean: string | null;
  product_name: string | null;
  price: number;
  in_stock: boolean;
  shop: string;
  shop_id: string;
  purchase_url: string | null;
  product_url: string | null;
  error?: string;
}
