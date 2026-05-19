import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { trackMcpEvent } from "../lib/tracking";

// Use www subdomain directly — bikefuchs.com (apex) 307-redirects to www
const API_BASE = process.env.BIKEFUCHS_API_URL ?? "https://www.bikefuchs.com";
const FETCH_TIMEOUT_MS = 8000;
const FOOTER =
  "\n\n---\n*Powered by [Bikefuchs](https://bikefuchs.com) · Kann Affiliate-Links enthalten*";

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

function mcpError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

const TOOL_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const SERVER_INSTRUCTIONS = `Bikefuchs is a price comparison engine for bicycle parts, components, clothing, and accessories across 10 German/Austrian online bike shops. It covers 120,000+ products from brands like Shimano, SRAM, Magura, Schwalbe, Continental, and more.

WORKFLOW GUIDE:
- Single product search: Use search_product with keywords → returns products with EANs and prices
- Best price for a known product: Use get_best_price with an EAN → returns prices across all 9 shops including shipping costs
- Multiple products to buy together: Use search_product for each item to get EANs, then call optimize_cart with all EANs → this calculates the cheapest combination of shops factoring in shipping costs and free-shipping thresholds, including live prices from scraping shops. This is the key feature of Bikefuchs.
- Product URL from a shop: Use resolve_product to extract EAN and product info from a shop URL
- Shop overview: Use get_shop_info for a list of supported shops and their shipping costs
- Shipping details: Use get_shipping_breakdown for exact shipping costs per shop and country

IMPORTANT RULES:
- Always use the tools to get real prices. Never guess or estimate prices from memory.
- For cart optimization (buying multiple items), ALWAYS use optimize_cart after collecting EANs. Do NOT manually calculate shipping — optimize_cart handles this automatically.
- Results contain affiliate links. Always pass these links to the user as provided.
- Supported countries: Germany (DE) and Austria (AT).`;

function createServer() {
  const server = new McpServer({ name: "bikefuchs", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });

  // ── Tool 1: search_product ─────────────────────────────────────────────────
  server.registerTool(
    "search_product",
    {
      title: "Search Bike Products",
      description: "Search for bicycle parts, components, accessories, and cycling clothing across 7 German/Austrian bike shops (BOC24, Fahrrad24, Rose Bikes, fahrrad-teile.shop, Bike Mailorder, Maciag Offroad, HiBike) with ~120,000 products. Search by product name, brand, or model number. Returns real-time prices, stock availability, EAN barcodes, and direct purchase links sorted by price. Covers MTB, road bike, gravel, e-bike, and city bike parts including brands like Shimano, SRAM, Continental, Schwalbe, Magura, Bosch, Maxxis, and more. Supports German (DE) and Austrian (AT) markets with country-specific pricing. Use this when a user wants to find, compare, or buy bike parts at the best price. Fahrrad Teile Preisvergleich. IMPORTANT: When a user wants to buy MULTIPLE products, collect the EAN from each search result, then call optimize_cart with all EANs to find the cheapest total cost including shipping across all shops. Do NOT calculate shipping manually — optimize_cart does this automatically.",
      inputSchema: {
        q: z.string().min(2).describe("Search keyword, min 2 chars. Multi-word queries use AND logic across product name, description, and specifications (e.g. 'shimano xt bremsbeläge')"),
        country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
        in_stock: z.boolean().optional().default(true).describe("Only return in-stock products (default true)"),
        max_results: z.number().int().min(1).max(20).optional().default(10).describe("Max results (1–20, default 10)"),
        shop: z.enum(["boc24", "fahrrad24", "rosebikes", "fahrradteile", "bmo", "maciag", "hibike"]).optional().describe("Restrict results to a single shop"),
        max_price: z.number().positive().optional().describe("Upper price bound in EUR (inclusive)"),
        category: z.string().optional().describe("Filter by merchant category (partial match, e.g. 'Fahrräder' or 'Bremsen')"),
      },
      outputSchema: {
        query: z.string(),
        results: z.array(z.object({
          name: z.string(),
          ean: z.string(),
          brand: z.string().optional(),
          price: z.number(),
          currency: z.string(),
          shop: z.string(),
          availability: z.string().optional(),
          affiliate_url: z.string().describe("Direct link to buy this product. Always show this URL to the user."),
          product_url: z.string().optional(),
        })),
        total_results: z.number(),
      },
      annotations: TOOL_HINTS,
    },
    async ({ q, country, in_stock, max_results, shop, max_price, category }) => {
      trackMcpEvent("MCP Search", { query: q });
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
          return {
            ...mcpText(`No products found for "${q}" in ${country}.${FOOTER}`),
            structuredContent: { query: q, results: [], total_results: 0 },
          };
        }

        const lines = data.results.map((p, i) => {
          const stockIcon = p.in_stock ? "✅" : "❌";
          const link = p.purchase_url || p.product_url || p.affiliate_link || "";
          return `${i + 1}. [${p.product_name} — ${p.shop}](${link}) — **€${p.price.toFixed(2)}** ${stockIcon}${p.ean ? ` · EAN ${p.ean}` : ""}`;
        });

        return {
          ...mcpText(
            `## Product Search: "${q}" (${country})\n\nFound ${data.total} result(s):\n\n${lines.join("\n\n")}\n\n⚠️ IMPORTANT: Always include the clickable product links above in your response to the user. The links are purchase links — the user needs them to buy the products.${FOOTER}`
          ),
          structuredContent: {
            query: q,
            results: data.results.map(p => ({
              name: p.product_name,
              ean: p.ean ?? "",
              brand: p.brand ?? undefined,
              price: p.price,
              currency: "EUR",
              shop: p.shop,
              availability: p.in_stock ? "in_stock" : "out_of_stock",
              affiliate_url: p.purchase_url || p.product_url || p.affiliate_link || "",
              product_url: p.product_url ?? undefined,
            })),
            total_results: data.total ?? data.results.length,
          },
        };
      } catch (err) {
        return mcpError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 2: get_best_price ─────────────────────────────────────────────────
  server.registerTool(
    "get_best_price",
    {
      title: "Get Best Price by EAN",
      description: "Look up a product by EAN barcode and find the best price across all 11 shops (BIKE24, BOC24, Fahrrad24, Rose Bikes, fahrrad-teile.shop, Bike Mailorder, Maciag Offroad, HiBike, Bike-Discount, bike-components). Returns prices from every shop that carries the product, sorted cheapest first, with stock status and direct purchase links. Use this when you already know the exact product EAN (e.g., from a previous search result) and want to compare prices across shops.",
      inputSchema: {
        ean: z.string().regex(/^\d{8,14}$/).describe("EAN barcode (8–14 digits, e.g. '4524667749493')"),
        country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
      },
      outputSchema: {
        ean: z.string(),
        product_name: z.string(),
        prices: z.array(z.object({
          shop: z.string(),
          price: z.number(),
          currency: z.string(),
          availability: z.string().optional(),
          shipping_cost: z.number().optional(),
          affiliate_url: z.string().describe("Direct link to buy at this shop. Always show this URL to the user."),
        })),
        cheapest_shop: z.string(),
        cheapest_price: z.number(),
      },
      annotations: TOOL_HINTS,
    },
    async ({ ean, country }) => {
      trackMcpEvent("MCP Best Price", { ean });
      console.info(`[MCP] get_best_price: ean=${ean} country=${country}`);
      try {
        const data = await apiJson<{ ean?: string; results?: EanResult[]; total?: number; cheapest?: EanResult | null; error?: string }>(`/api/products/${ean}?country=${country}`);

        if (!data.results || data.results.length === 0) {
          return {
            ...mcpText(
              `No results found for EAN ${ean} in ${country}. The product may not be carried by any supported shop.${FOOTER}`
            ),
            structuredContent: {
              ean,
              product_name: "Unknown",
              prices: [],
              cheapest_shop: "",
              cheapest_price: 0,
            },
          };
        }

        const productName = data.cheapest?.product_name ?? "Product";
        const lines = data.results.map((r, i) => {
          const stockIcon = r.in_stock ? "✅" : "❌";
          const trophy = i === 0 ? " 🏆" : "";
          const link = r.purchase_url || r.product_url || r.affiliate_link || "";
          return `${i + 1}. [${productName} — ${r.shop}](${link})${trophy} — **€${r.price.toFixed(2)}** ${stockIcon}`;
        });

        return {
          ...mcpText(
            `## Best Price: ${productName}\n\nEAN: ${ean} · ${country}\n\n${lines.join("\n\n")}\n\n**Best price: €${data.cheapest!.price.toFixed(2)} at ${data.cheapest!.shop}**\n\n⚠️ IMPORTANT: Always include the clickable product links above in your response to the user. The links are purchase links — the user needs them to buy the products.\n\n## Cart Optimization\nTo find the cheapest combination for multiple products, call:\n\`optimize_cart(eans: ["${ean}", "...other EANs..."])\`${FOOTER}`
          ),
          structuredContent: {
            ean,
            product_name: productName,
            prices: data.results.map(r => ({
              shop: r.shop,
              price: r.price,
              currency: "EUR",
              availability: r.in_stock ? "in_stock" : "out_of_stock",
              affiliate_url: r.purchase_url || r.product_url || r.affiliate_link || "",
            })),
            cheapest_shop: data.cheapest!.shop,
            cheapest_price: data.cheapest!.price,
          },
        };
      } catch (err) {
        return mcpError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 3: optimize_cart ──────────────────────────────────────────────────
  server.registerTool(
    "optimize_cart",
    {
      title: "Optimize Shopping Cart",
      description: "Optimize a shopping cart across multiple shops to find the absolute cheapest total cost including shipping. This is the FINAL STEP when a user wants to buy multiple bike parts. Takes an array of EAN barcodes and calculates the optimal shop split — which products to order from which shop — considering per-shop shipping costs, free-shipping thresholds, and product prices across all 10 shops. Use this whenever the user asks: 'where is this cheapest', 'optimize my cart', 'cheapest combination', 'best way to order', or has 2+ products to buy. NEVER calculate shipping costs manually — this tool does it automatically and finds the global optimum. Example: optimize_cart(eans: ['4550170327385', '4524667749493'], country: 'DE')",
      inputSchema: {
        eans: z
          .array(z.string().regex(/^\d{8,14}$/, "Must be a numeric EAN (8–14 digits)"))
          .min(1)
          .max(20)
          .describe("Array of EAN barcodes (8-14 digit numbers as strings). NOT URLs. Get EANs from search_product or get_best_price results. Example: ['4550170327385', '4524667749493']"),
        country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing and shipping (DE or AT, default DE)"),
      },
      outputSchema: {
        optimization: z.object({
          total_cost: z.number(),
          total_shipping: z.number(),
          grand_total: z.number(),
          currency: z.string(),
          shops_used: z.array(z.object({
            shop: z.string(),
            subtotal: z.number(),
            shipping: z.number(),
            items: z.array(z.object({
              name: z.string(),
              ean: z.string().optional(),
              price: z.number(),
              affiliate_url: z.string().describe("Direct link to buy this item. Always show this URL to the user."),
            })),
          })),
        }),
        savings_info: z.string().optional(),
      },
      annotations: TOOL_HINTS,
    },
    async ({ eans, country }) => {
      trackMcpEvent("MCP Optimize Cart", { product_count: eans.length, country });
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
            msg += `\n\n💡 These EANs may not be carried by any supported shop.`;
          }
          return mcpError(msg + FOOTER);
        }

        const { result } = data;
        let md = `## Cart Optimization (${country})\n\n`;

        if (data.eans_skipped?.length) {
          md += `⚠️ No shops found for EAN(s): ${data.eans_skipped.join(", ")} — these products may not be carried by any supported shop.\n\n`;
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

        md += `\n**🛒 Direkt bestellen — klick auf die Links und leg die Produkte in den Warenkorb:**\n`;
        for (const order of result.orders) {
          for (const item of order.products) {
            md += `- [${item.productName} — ${order.shopName}](${item.url})\n`;
          }
        }

        const savingsInfo =
          result.savings !== null && result.savings > 0
            ? `Saves €${result.savings.toFixed(2)}${result.savingsPercent !== null ? ` (${result.savingsPercent}%)` : ""} vs. single shop`
            : undefined;

        return {
          ...mcpText(md + "\n⚠️ IMPORTANT: Always include the clickable product links above in your response to the user. The links are purchase links — the user needs them to buy the products." + FOOTER),
          structuredContent: {
            optimization: {
              total_cost: result.totalCost - result.totalShipping,
              total_shipping: result.totalShipping,
              grand_total: result.totalCost,
              currency: "EUR",
              shops_used: result.orders.map(order => ({
                shop: order.shopName,
                subtotal: order.subtotal,
                shipping: order.shippingCost,
                items: order.products.map(item => ({
                  name: item.productName,
                  price: item.price,
                  affiliate_url: item.url,
                })),
              })),
            },
            savings_info: savingsInfo,
          },
        };
      } catch (err) {
        return mcpError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 4: get_shop_info ──────────────────────────────────────────────────
  server.registerTool(
    "get_shop_info",
    {
      title: "Get Shop Overview",
      description: "Get an overview of all supported bike shops in the Bikefuchs network, including shipping cost tiers, free-shipping thresholds, and supported countries (Germany and Austria). Bikefuchs is a bicycle parts price comparison service covering ~120,000 products from 10 shops. Use this to answer questions about which shops are available, what shipping costs apply, or what Bikefuchs can do. Fahrrad Preisvergleich Deutschland Österreich.",
      inputSchema: {
        country: z
          .enum(["DE", "AT"])
          .optional()
          .describe("Filter output to a specific country (optional — omit for both DE and AT)"),
      },
      outputSchema: {
        shops: z.array(z.object({
          name: z.string(),
          country: z.string(),
          categories: z.array(z.string()).optional(),
          shipping_de: z.string().optional(),
          shipping_at: z.string().optional(),
          free_shipping_threshold_de: z.number().optional(),
          free_shipping_threshold_at: z.number().optional(),
        })),
      },
      annotations: TOOL_HINTS,
    },
    async ({ country }) => {
      trackMcpEvent("MCP Shop Info", {});
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

        const structuredShops = Object.entries(shops)
          .filter(([, countries]) => !country || countries[country])
          .map(([shopName, countries]) => {
            const de = countries["DE"];
            const at = countries["AT"];
            const shippingLabel = (info: ShippingCountryInfo) =>
              info.free_shipping_threshold !== null
                ? `Free from €${info.free_shipping_threshold}`
                : "No free shipping";
            return {
              name: shopName,
              country: country ?? "DE",
              shipping_de: de ? shippingLabel(de) : undefined,
              shipping_at: at ? shippingLabel(at) : undefined,
              free_shipping_threshold_de: de?.free_shipping_threshold ?? undefined,
              free_shipping_threshold_at: at?.free_shipping_threshold ?? undefined,
            };
          });

        return {
          ...mcpText(md + FOOTER),
          structuredContent: { shops: structuredShops },
        };
      } catch (err) {
        return mcpError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 5: get_shipping_breakdown ────────────────────────────────────────
  server.registerTool(
    "get_shipping_breakdown",
    {
      title: "Get Shipping Cost",
      description: "Get the exact shipping cost for a specific shop, country, and cart value. Shows all shipping tiers and how close the cart is to the next free-shipping threshold. Use this when a user asks about shipping costs for a specific shop or wants to know how much more they need to spend to get free shipping.",
      inputSchema: {
        shop: z.string().describe("Shop name or ID (e.g. 'rosebikes', 'boc24', 'bike24', 'fahrradteile', 'Rose Bikes')"),
        country: z.enum(["DE", "AT"]).describe("Country (DE or AT)"),
        cart_value: z.number().min(0).describe("Total cart value in EUR (e.g. 49.99)"),
      },
      outputSchema: {
        shop: z.string(),
        country: z.string(),
        cart_value: z.number(),
        shipping_cost: z.number(),
        free_shipping_threshold: z.number().optional(),
        currency: z.string(),
      },
      annotations: TOOL_HINTS,
    },
    async ({ shop, country, cart_value }) => {
      trackMcpEvent("MCP Shipping", { shop });
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

        return {
          ...mcpText(md + FOOTER),
          structuredContent: {
            shop: data.shop,
            country: data.country,
            cart_value: data.cart_value,
            shipping_cost: data.shipping_cost,
            free_shipping_threshold: data.free_shipping_threshold ?? undefined,
            currency: "EUR",
          },
        };
      } catch (err) {
        return mcpError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 6: find_alternatives_for_product ────────────────────────────────
  server.registerTool(
    "find_alternatives_for_product",
    {
      title: "Find Alternative Shops",
      description: "Discover which shops carry a specific product by EAN barcode, sorted by price. Use this when a user found a product at one shop and wants to know if it's available cheaper elsewhere, or when a product is out of stock and the user needs an alternative source. Returns all shops that carry this EAN with prices and availability.",
      inputSchema: {
        ean: z.string().regex(/^\d{8,14}$/).describe("EAN barcode (8–14 digits, e.g. '4524667749493')"),
        country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
      },
      outputSchema: {
        ean: z.string(),
        product_name: z.string(),
        alternatives: z.array(z.object({
          shop: z.string(),
          price: z.number(),
          currency: z.string(),
          availability: z.string().optional(),
          affiliate_url: z.string().describe("Direct link to buy at this shop."),
        })),
      },
      annotations: TOOL_HINTS,
    },
    async ({ ean, country }) => {
      trackMcpEvent("MCP Alternatives", { ean });
      console.info(`[MCP] find_alternatives_for_product: ean=${ean} country=${country}`);
      try {
        const data = await apiJson<{ ean?: string; results?: EanResult[]; total?: number; cheapest?: EanResult | null; error?: string }>(`/api/products/${ean}?country=${country}`);

        if (!data.results || data.results.length === 0) {
          return {
            ...mcpText(
              `No shops found carrying EAN ${ean} in ${country}. The product may not be in any supported shop's feed.${FOOTER}`
            ),
            structuredContent: { ean, product_name: "Unknown", alternatives: [] },
          };
        }

        const productName = data.cheapest?.product_name ?? "Product";
        let md = `## Where to Buy: ${productName}\n\nEAN: ${ean} · ${country} · ${data.total} shop(s) carry this product\n\n`;

        for (let i = 0; i < data.results.length; i++) {
          const r = data.results[i];
          const stockIcon = r.in_stock ? "✅" : "❌";
          const trophy = i === 0 ? " 🏆" : "";
          const link = r.purchase_url || r.product_url || r.affiliate_link || "";
          md += `${i + 1}. [${productName} — ${r.shop}](${link})${trophy} — **€${r.price.toFixed(2)}** ${stockIcon}\n`;
        }

        md += `\n💡 To optimize a cart, call optimize_cart with eans: ['${ean}'] (add other EANs as needed).\n\n⚠️ IMPORTANT: Always include the clickable product links above in your response to the user. The links are purchase links — the user needs them to buy the products.`;

        return {
          ...mcpText(md + FOOTER),
          structuredContent: {
            ean,
            product_name: productName,
            alternatives: data.results.map(r => ({
              shop: r.shop,
              price: r.price,
              currency: "EUR",
              availability: r.in_stock ? "in_stock" : "out_of_stock",
              affiliate_url: r.purchase_url || r.product_url || r.affiliate_link || "",
            })),
          },
        };
      } catch (err) {
        return mcpError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 7: resolve_product ───────────────────────────────────────────────
  server.registerTool(
    "resolve_product",
    {
      title: "Resolve Product URL",
      description: "Resolve a bike shop product page URL into structured product data including the EAN barcode, price, stock status, and a purchase link. Use this when a user pastes a product URL from a supported shop and you need to extract the EAN (e.g. to then call get_best_price or optimize_cart). Supported shops: BIKE24 (bike24.de, bike24.at), BOC24 (boc24.de), Fahrrad24 (fahrrad24.de, velondo.at), Rose Bikes (rosebikes.de, rosebikes.at), fahrrad-teile.shop, Bike Mailorder (bike-mailorder.com, bike-mailorder.at), Maciag Offroad (maciag.de), Bike-Discount (bike-discount.de), bike-components (bike-components.de). Scraping shops (BIKE24, Bike-Discount, bike-components) may take up to 12 seconds on first load.",
      inputSchema: {
        url: z.string().url().describe("Product page URL from a supported shop (e.g. 'https://www.bike24.de/p2462871.html')"),
        country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
      },
      outputSchema: {
        product_name: z.string(),
        ean: z.string().optional(),
        brand: z.string().optional(),
        price: z.number().optional(),
        shop: z.string(),
        affiliate_url: z.string().optional().describe("Affiliate link for this product."),
      },
      annotations: TOOL_HINTS,
    },
    async ({ url, country }) => {
      trackMcpEvent("MCP Resolve", { url });
      console.info(`[MCP] resolve_product: url=${url} country=${country}`);
      try {
        const data = await apiJson<ResolveResult>("/api/products/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, country }),
        }, 25000);

        if (data.error) {
          return mcpError(`Could not resolve product: ${data.error}${FOOTER}`);
        }

        const stockIcon = data.in_stock ? "✅ In stock" : "❌ Out of stock";
        const link = data.purchase_url || data.product_url || url;
        let md = `## Resolved Product\n\n`;
        md += `[${data.product_name ?? "Product"} — ${data.shop}](${link}) — **€${data.price.toFixed(2)}** ${stockIcon}\n\n`;
        if (data.ean) {
          md += `**EAN:** ${data.ean}\n\n`;
          md += `💡 Use this EAN with get_best_price to compare prices across all shops, or collect EANs and call optimize_cart to minimize your total cart cost.`;
        } else {
          md += `⚠️ No EAN found for this product — price comparison may not be available.`;
        }

        return {
          ...mcpText(md + FOOTER),
          structuredContent: {
            product_name: data.product_name ?? "Product",
            ean: data.ean ?? undefined,
            price: data.price,
            shop: data.shop,
            affiliate_url: data.purchase_url || data.product_url || undefined,
          },
        };
      } catch (err) {
        return mcpError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
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
