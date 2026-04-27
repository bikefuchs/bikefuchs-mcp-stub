import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { NextRequest } from "next/server";
import { z } from "zod";

// Use www subdomain directly — bikefuchs.com (apex) 307-redirects to www
const API_BASE = process.env.BIKEFUCHS_API_URL ?? "https://www.bikefuchs.com";
const FETCH_TIMEOUT_MS = 8000;
const FOOTER =
  "\n\n---\n*Powered by [Bikefuchs](https://bikefuchs.com) — Bike price comparison for DE & AT*";

async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = new Headers(options?.headers);
    headers.set("Accept", "application/json");
    return await fetch(`${API_BASE}${path}`, { ...options, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function apiJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await apiFetch(path, options);
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

function createServer() {
  const server = new McpServer({ name: "bikefuchs", version: "1.0.0" });

  // ── Tool 1: search_product ─────────────────────────────────────────────────
  server.tool(
    "search_product",
    "Search for bike products by keyword across 5 German/Austrian bike shops (BOC24, Fahrrad24/Velondo, Rose Bikes, fahrrad-teile.shop, Bike Mailorder). Returns products sorted by price.",
    {
      q: z.string().min(2).describe("Search keyword, min 2 chars. Multi-word queries use AND logic across product name, description, and specifications (e.g. 'shimano xt bremsbeläge')"),
      country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
      in_stock: z.boolean().optional().default(true).describe("Only return in-stock products (default true)"),
      max_results: z.number().int().min(1).max(20).optional().default(10).describe("Max results (1–20, default 10)"),
      shop: z.enum(["boc24", "fahrrad24", "rosebikes", "fahrradteile", "bmo"]).optional().describe("Restrict results to a single shop"),
      max_price: z.number().positive().optional().describe("Upper price bound in EUR (inclusive)"),
      category: z.string().optional().describe("Filter by merchant category (partial match, e.g. 'Fahrräder' or 'Bremsen')"),
    },
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
          const stock = p.in_stock ? "in stock" : "out of stock";
          const link = p.purchase_url ?? p.product_url ?? "";
          return `${i + 1}. **${p.product_name}**\n   ${p.shop} · €${p.price.toFixed(2)} · ${stock}${p.ean ? ` · EAN ${p.ean}` : ""}\n   [View product](${link})`;
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
    "Look up a product by EAN barcode and find the best price across all feed shops (BOC24, Fahrrad24/Velondo, Rose Bikes, fahrrad-teile.shop, Bike Mailorder). Returns all shops that carry this product, sorted by price.",
    {
      ean: z.string().regex(/^\d{8,14}$/).describe("EAN barcode (8–14 digits, e.g. '4524667749493')"),
      country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
    },
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
          const stock = r.in_stock ? "in stock" : "out of stock";
          const tag = i === 0 ? " 🏆 cheapest" : "";
          const link = r.purchase_url ?? r.product_url ?? "";
          return `${i + 1}. **${r.shop}**${tag} — €${r.price.toFixed(2)} (${stock})\n   [Buy here](${link})`;
        });

        return mcpText(
          `## Best Price: ${productName}\n\nEAN: ${ean} · ${country}\n\n${lines.join("\n\n")}\n\n**Best price: €${data.cheapest!.price.toFixed(2)} at ${data.cheapest!.shop}**${FOOTER}`
        );
      } catch (err) {
        return mcpText(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 3: optimize_cart ──────────────────────────────────────────────────
  server.tool(
    "optimize_cart",
    "Optimize a shopping cart of bike products by finding the cheapest shop combination including shipping costs. Provide 1–20 product page URLs from supported shops. Returns the optimal shop split with total cost including shipping.",
    {
      urls: z
        .array(z.string().url())
        .min(1)
        .max(20)
        .describe(
          "Array of product page URLs (1–20). Supported shops: boc24.de, fahrrad24.de, velondo.at, rosebikes.de, rosebikes.at, fahrrad-teile.shop, bike-mailorder.com"
        ),
      country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing and shipping (DE or AT, default DE)"),
    },
    async ({ urls, country }) => {
      console.info(`[MCP] optimize_cart: ${urls.length} URL(s) country=${country}`);
      try {
        const data = await apiJson<OptimizeResult>("/api/cart/optimize-from-urls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls, country }),
        });

        let md = `## Cart Optimization (${country})\n\n`;

        if (data.products_resolved?.length) {
          md += `### Resolved Products\n`;
          for (const p of data.products_resolved) {
            md += `- **${p.product_name ?? "Unknown"}** (EAN: ${p.ean})\n`;
            md += `  ${p.source_shop} · €${p.source_price.toFixed(2)} · ${p.alternatives_found} alternative(s)\n`;
          }
          md += "\n";
        }

        const opt = data.optimization;
        if (opt?.shopBreakdown) {
          md += `### Optimal Shop Split\n`;
          for (const [shop, info] of Object.entries(opt.shopBreakdown)) {
            md += `\n**${shop}** — products €${info.subtotal.toFixed(2)} + shipping €${info.shipping.toFixed(2)}\n`;
            for (const item of info.items) {
              md += `  - ${item.productName}: €${item.price.toFixed(2)} — [Buy](${item.url})\n`;
            }
          }
          md += `\n**Total cost: €${opt.totalCost.toFixed(2)}**`;
          if (opt.savings !== null && opt.savings > 0) {
            md += ` *(saves €${opt.savings.toFixed(2)} vs. single shop)*`;
          }
          md += "\n";
        }

        if (data.errors?.length) {
          md += `\n### Warnings\n`;
          for (const e of data.errors) {
            md += `- ${e.error}\n  URL: ${e.url}\n`;
          }
        }

        return mcpText(md + FOOTER);
      } catch (err) {
        return mcpText(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 4: get_shop_info ──────────────────────────────────────────────────
  server.tool(
    "get_shop_info",
    "Get an overview of all supported bike shops with their shipping tiers and free-shipping thresholds for DE and AT. Use this before recommending where to buy.",
    {
      country: z
        .enum(["DE", "AT"])
        .optional()
        .describe("Filter output to a specific country (optional — omit for both DE and AT)"),
    },
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
    "Get the exact shipping cost for a specific shop, country, and cart value. Shows all shipping tiers and how close the cart is to the free-shipping threshold.",
    {
      shop: z.string().describe("Shop name or ID (e.g. 'rosebikes', 'boc24', 'bike24', 'fahrradteile', 'Rose Bikes')"),
      country: z.enum(["DE", "AT"]).describe("Country (DE or AT)"),
      cart_value: z.number().min(0).describe("Total cart value in EUR (e.g. 49.99)"),
    },
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
    "Discover which shops carry a specific product by EAN barcode, sorted by price. Use this when you already know the EAN and want to find where to buy it — focused on availability discovery across shops rather than price comparison.",
    {
      ean: z.string().regex(/^\d{8,14}$/).describe("EAN barcode (8–14 digits, e.g. '4524667749493')"),
      country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
    },
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
          const stock = r.in_stock ? "in stock" : "out of stock";
          const tag = i === 0 ? " 🏆 best price" : "";
          const link = r.purchase_url ?? r.product_url ?? "";
          md += `${i + 1}. **${r.shop}**${tag} — €${r.price.toFixed(2)} (${stock})\n   [Buy here](${link})\n`;
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

interface OptimizeShopInfo {
  subtotal: number;
  shipping: number;
  items: Array<{ productName: string; price: number; url: string }>;
}

interface OptimizeResult {
  success: boolean;
  country: string;
  products_resolved: Array<{
    input_url: string;
    ean: string;
    product_name: string | null;
    source_shop: string;
    source_price: number;
    alternatives_found: number;
  }>;
  optimization: {
    totalCost: number;
    savings: number | null;
    shopBreakdown: Record<string, OptimizeShopInfo>;
  } | null;
  errors?: Array<{ url: string; error: string }>;
  error?: string;
}
