import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { trackMcpEvent } from "./tracking";
import { recordCoverage, extractEansFromMcp, RL_SOURCE_HEADER } from "./rateLimit";

// Use www subdomain directly — bikefuchs.com (apex) 307-redirects to www
const API_BASE = process.env.BIKEFUCHS_API_URL ?? "https://www.bikefuchs.com";
const FETCH_TIMEOUT_MS = 8000;
const FOOTER =
  "\n\n---\n*Powered by [Bikefuchs](https://bikefuchs.com)* 🦊 *· Kann Affiliate-Links enthalten*";
// B-164a: openai footer. Same disclosure text, but the bikefuchs.com link is a BARE
// URL (not a Markdown link) because ChatGPT renders Markdown-from-tool-text as plain,
// unclickable text — the same reason /go/ links are emitted bare on the openai profile.
const FOOTER_OPENAI =
  "\n\n---\nPowered by Bikefuchs 🦊 · https://bikefuchs.com · Kann Affiliate-Links enthalten";
// Profile-rendered footer: claude keeps the (already-clickable) Markdown link —
// footer('claude') === FOOTER byte-for-byte — openai gets the bare-URL variant.
function footer(profile: RenderProfile): string {
  return profile === 'openai' ? FOOTER_OPENAI : FOOTER;
}
const DISCLOSURE_DIRECTIVE =
  "\n\n⚠️ IMPORTANT: Always end your reply to the user with this exact line (italic text, but the 🦊 emoji NOT italic): *Powered by [Bikefuchs](https://bikefuchs.com)* 🦊 *· Kann Affiliate-Links enthalten*";

// B-196 (Claude endpoint only): 2-call warm directive. On a cold scraping cache the
// slow BIKE24 scrape (~20s) has NOT finished when get_best_price returns, so a scraping
// shop is missing or only transiently Unavailable in this first result — the cheapest
// shop shown may be wrong. The API reports this via scraping_pending; the persistence
// half (B-188) guarantees a SECOND get_best_price call ~20–30s later reads the
// converged price. This directive makes the model perform that second call. Emitted
// ONLY when scraping_pending is true AND only on the claude profile (feedOnly===false) —
// the openai/feed-only profile has no scraping shops and must never see it. Lives in the
// content block (Claude reads content, not structuredContent). The "only ONCE" guard
// mirrors the optimize_cart stale-gate wording so a non-converging edge can't loop
// (full convergence of the Unavailable marker is tracked separately in B-195).
const WARMING_REFRESH_DIRECTIVE =
  "\n\n⏳ IMPORTANT — prices still warming: Live prices from one or more scraping shops (e.g. BIKE24) are NOT yet included above, so this comparison may be incomplete and the cheapest shop may still change. Call get_best_price for this exact EAN ONE more time in ~20–30 seconds to get the final, complete result, and tell the user the live prices are still loading and you will check again shortly. Do this refresh only ONCE — if a shop is still reported as pending after you have already refreshed once, present the best result you have and note that one shop's live price could not be confirmed right now.";

// B-178: shared model-facing directive that stops both profiles from collapsing
// the ranked search_product list to a single hit (and dropping the cheapest).
// Single source of truth, referenced in BOTH profiles per the parity rule:
// appended to TELL_USER_SEARCH (openai `tell_user` structuredContent) and emitted
// in the claude content block. Declared before TELL_USER_SEARCH to avoid a
// const temporal-dead-zone reference.
const PRESENT_LIST_DIRECTIVE =
  "IMPORTANT: Show ALL returned products as a ranked list, cheapest first — never collapse them to a single product, summarize them away, or omit the cheapest result.";

// ── B-162 pilot (openai profile only) ────────────────────────────────────────
// Disclosure + model-facing guidance carried INSIDE structuredContent, so the
// programmatic ChatGPT channel (which reads structuredContent, not content) can
// surface affiliate disclosure and "what to tell the user" reliably. These are
// emitted ONLY when renderProfile === 'openai'; the claude path never sees them.
// B-162 rollout: the `disclosure` structuredContent field uses the FOOTER
// constant verbatim (single source of truth) on every tool — this REPLACES the
// pilot's interim wording on get_best_price/optimize_cart. `tell_user` is the
// per-tool model-facing instruction; each one ends with the `disclosure` text.
const TELL_USER_SEARCH =
  "Present the found products with their price, shop, and clickable bikefuchs.com/go/ link. Respond in the user's language. End with the `disclosure` text. Do not auto-chain — offer the user the two next_steps as a choice. " +
  PRESENT_LIST_DIRECTIVE;
const TELL_USER_ALTERNATIVES =
  "Present each alternative with price, shop, and its bikefuchs.com/go/ link. Respond in the user's language. End with the `disclosure` text.";
const TELL_USER_RESOLVE =
  "Confirm the resolved product, then offer the price check via the next_step. Show the bikefuchs.com/go/ link. End with the `disclosure` text.";
const TELL_USER_SHOP_INFO =
  "Present the compared shops with their shipping cost tiers and free-shipping thresholds. For an exact figure, point to get_shipping_breakdown (next_step). End with the `disclosure` text.";
const TELL_USER_SHIPPING =
  "Present the shipping cost for the given cart value, the free-shipping threshold and any gap. End with the `disclosure` text.";
const PILOT_TELL_USER_BEST_PRICE =
  "Show the cheapest shop with its price and clickable purchase link, then the other shops with price and link. Always surface every bikefuchs.com/go/ link. Respond in the user's language. End your reply with the `disclosure` text.";
const PILOT_TELL_USER_OPTIMIZE_CART =
  "Show the per-shop split (which items at which shop, subtotal and shipping per shop), the grand total including shipping, and the savings. If single_shop_option is present, also mention it. Surface every item's bikefuchs.com/go/ link. Respond in the user's language. End your reply with the `disclosure` text.";

// Round a monetary number to 2 decimals. Used ONLY for the openai-profile
// structuredContent (fixes float artifacts like 97.30000000000001). The claude
// path keeps the raw upstream numbers untouched.
const round2 = (n: number): number => Math.round(n * 100) / 100;

// B-164a: the single-shop invitation only calls the premium "nur" ("only") when
// it is genuinely small. Since the 20% show-window cap was removed, the option
// can surface at a high premium where "nur +88 %" reads absurd — so the word is
// dropped above this threshold (percent). Same value + behaviour on both profiles.
const SINGLE_SHOP_NUR_THRESHOLD = 20;
const singleShopNur = (deltaPercent: number): string =>
  deltaPercent <= SINGLE_SHOP_NUR_THRESHOLD ? 'nur ' : '';

// ── Render profile ───────────────────────────────────────────────────────────
// Per-endpoint link rendering. 'claude' (default, /mcp) is byte-for-byte the
// historical behavior: products are markdown links [name — shop](go-url), which
// Claude renders reliably. 'openai' (/mcp/openai) emits the SAME /go/ URL as a
// BARE plain-text https:// line, because ChatGPT does not reliably render
// markdown links from tool-result text but does linkify bare URLs.
// This is intentionally separate from `feedOnly` (shop filtering) — the two
// concepts never key off each other.
type RenderProfile = 'claude' | 'openai';

// Links directive that accompanies product results in the content block. The
// 'claude' string is byte-identical to the historical inline literal; the
// 'openai' string is tuned for ChatGPT's bare-URL rendering.
const LINKS_DIRECTIVE_CLAUDE =
  "⚠️ IMPORTANT: Always include the clickable product links above in your response to the user. The links are purchase links — the user needs them to buy the products.";
const LINKS_DIRECTIVE_OPENAI =
  "IMPORTANT: For every product you show the user, output its full https://www.bikefuchs.com/go/... URL as plain text on its own line so it is clickable. Never omit, shorten, or rewrite these URLs — they are the purchase links the user needs.";
function linksDirective(profile: RenderProfile): string {
  return profile === 'openai' ? LINKS_DIRECTIVE_OPENAI : LINKS_DIRECTIVE_CLAUDE;
}

// Renders one product entry split into: head (numbering/indent) + clickable
// label + tail (price/stock/EAN/trophy...). 'claude' wraps the label as a
// markdown link `[label](url)` — byte-identical to the original expressions at
// every call site (sites that always emitted `[label](url)`). 'openai' emits
// the plain label and appends the bare /go/ URL on its own indented line
// (only when a URL exists). resolve_product keeps its own conditional because
// its historical claude output drops the brackets entirely when url is empty.
function productEntry(
  profile: RenderProfile,
  head: string,
  label: string,
  url: string,
  tail: string,
  urlIndent = '   ',
): string {
  if (profile === 'openai') {
    return url
      ? `${head}${label}${tail}\n${urlIndent}${url}`
      : `${head}${label}${tail}`;
  }
  // claude (default): exactly the original `${head}[${label}](${url})${tail}`
  return `${head}[${label}](${url})${tail}`;
}

const INTERNAL_ID_TO_SLUG: Record<string, string> = {
  'boc24': 'boc24',
  'fahrrad24': 'fahrrad24',
  'rosebikes': 'rose-bikes',
  'fahrradteile': 'fahrrad-teile-shop',
  'bmo': 'bike-mailorder',
  'maciag': 'maciag-offroad',
  'hibike': 'hibike',
  'bike24': 'bike24',
  'bike-discount': 'bike-discount',
  'bike-components': 'bike-components',
};

const DISPLAY_NAME_TO_SLUG: Record<string, string> = {
  'BOC24': 'boc24',
  'Fahrrad24': 'fahrrad24',
  'Rose Bikes': 'rose-bikes',
  'ROSE Bikes': 'rose-bikes',
  'fahrrad-teile.shop': 'fahrrad-teile-shop',
  'Fahrradteile': 'fahrrad-teile-shop',
  'Bike Mailorder': 'bike-mailorder',
  'Maciag Offroad': 'maciag-offroad',
  'HiBike': 'hibike',
  'BIKE24': 'bike24',
  'Bike-Discount': 'bike-discount',
  'bike-components': 'bike-components',
};

// ── Shop roster ────────────────────────────────────────────────────────────────
// Single source of truth: src/config/shops.ts in the website repo.
// Update both files whenever the shop list changes.
const FEED_SHOPS = ['BOC24', 'Fahrrad24', 'Rose Bikes', 'fahrrad-teile.shop', 'Bike Mailorder', 'Maciag Offroad', 'HiBike'];
const SCRAPING_SHOPS = ['BIKE24', 'Bike-Discount', 'bike-components'];
const ALL_SHOPS = [...FEED_SHOPS, ...SCRAPING_SHOPS];
const SHOP_COUNT = ALL_SHOPS.length; // 10 — update when shops.ts changes

// ── Feed-only mode (/mcp/openai) ────────────────────────────────────────────
// The 7 authorized feed shops are exposed; the 3 scraping shops (BIKE24,
// Bike-Discount, bike-components) must never be revealed or counted.
// Filtering keys, by the identifier each tool actually carries:
//   - shop_id (internal id)  → search_product, get_best_price, find_alternatives, resolve_product
//   - display name (shipping_costs table key) → get_shop_info
//   - free-text shop input    → get_shipping_breakdown
const FEED_SHOP_IDS = new Set(['boc24', 'fahrrad24', 'rosebikes', 'fahrradteile', 'bmo', 'maciag', 'hibike']);
const SCRAPING_SHOP_IDS = new Set(['bike24', 'bike-discount', 'bike-components']);
// Exact table-side display names of the 3 scraping shops (note capital C in
// "Bike-Components" as stored in shipping_costs; lower-case variant kept defensively).
const SCRAPING_DISPLAY_NAMES = new Set(['BIKE24', 'Bike-Discount', 'Bike-Components', 'bike-components']);
// Lower-cased free-text forms a user might pass to get_shipping_breakdown.
const SCRAPING_SHOP_INPUTS = new Set(['bike24', 'bike-discount', 'bike-components', 'bike components']);

function buildGoUrl(shopId: string | null, ean: string | null, toolName: string): string {
  if (!shopId) return "";
  const slug = INTERNAL_ID_TO_SLUG[shopId] ?? shopId;
  const eanSegment = ean && /^\d{8,14}$/.test(ean) ? ean : 'home';
  return `https://www.bikefuchs.com/go/${slug}/${eanSegment}?src=mcp&loc=${toolName}`;
}

async function apiFetch(path: string, options?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(options?.headers);
    headers.set("Accept", "application/json");
    // Identify trusted MCP→main-app traffic so the main app's rate-limiter
    // (Chokepoint 1) skips it (already limited here at Chokepoint 2).
    const mcpSecret = process.env.MCP_INTERNAL_SECRET;
    if (mcpSecret) headers.set("x-bikefuchs-mcp", mcpSecret);
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

function formatEuro(value: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

// Customer-facing percentage in German style: comma decimal + space before %.
// Formats the SAME value (no extra multiply/round) — only swaps the decimal point.
function formatPercent(value: number): string {
  return `${String(value).replace('.', ',')} %`;
}

const TOOL_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function buildServerInstructions(shopCount: number): string {
  return `Bikefuchs is a price comparison engine for bicycle parts, components, clothing, and accessories across ${shopCount} German/Austrian online bike shops. It covers 120,000+ products from brands like Shimano, SRAM, Magura, Schwalbe, Continental, and more.

WORKFLOW GUIDE:
- Single product search: Use search_product with keywords → returns products with EANs and prices
- Best price for a known product: Use get_best_price with an EAN → returns the product price at each shop (sorted cheapest-first). Shipping is NOT included here — use optimize_cart or get_shipping_breakdown for totals including shipping
- Multiple products to buy together: Use search_product for each item to get EANs, then call optimize_cart with all EANs → this calculates the cheapest combination of shops factoring in shipping costs and free-shipping thresholds. This is the key feature of Bikefuchs.
- Product URL from a shop: Use resolve_product to extract EAN and product info from a shop URL
- Shop overview: Use get_shop_info for a list of supported shops and their shipping costs
- Shipping details: Use get_shipping_breakdown for exact shipping costs per shop and country
- Same product cheaper elsewhere, or out of stock: Use find_alternatives_for_product with the EAN → returns every shop that carries it with prices and availability.

IMPORTANT RULES:
- Always use the tools to get real prices. Never guess or estimate prices from memory.
- For cart optimization (buying multiple items), ALWAYS use optimize_cart after collecting EANs. Do NOT manually calculate shipping — optimize_cart handles this automatically.
- Results contain affiliate links. Always pass these links to the user as provided.
- Answer product, price, availability, or shipping questions ONLY after a tool call has returned data. Never answer from the tool schema/description, and never reconstruct results from memory.
- Supported countries: Germany (DE) and Austria (AT).

Workflow for cart optimization: When the user wants to optimize a cart, first call get_best_price for each product, then call optimize_cart with all EANs. If optimize_cart returns missing_eans, call get_best_price for those EANs and retry optimize_cart.`;
}

function createServer({ feedOnly, renderProfile }: { feedOnly: boolean; renderProfile: RenderProfile }) {
  // Feed-only mode (/mcp/openai) exposes 7 shops; default mode exposes all 10.
  const shopCount = feedOnly ? FEED_SHOPS.length : SHOP_COUNT;
  const server = new McpServer({ name: "bikefuchs", version: "2.5.0" }, { instructions: buildServerInstructions(shopCount) });

  // ── Tool 1: search_product ─────────────────────────────────────────────────
  server.registerTool(
    "search_product",
    {
      title: "Search Bike Products",
      description: "Search for bicycle parts, components, accessories, and cycling clothing by name, brand, or model number. Returns matching products sorted cheapest-first, each with its price, stock status, EAN barcode, and a direct purchase link. Supports DE and AT pricing. If you already have a product's EAN, use get_best_price instead.",
      inputSchema: {
        q: z.string().min(2).describe("Search keyword, min 2 chars. Multi-word queries use AND logic across product name, description, and specifications (e.g. 'shimano xt bremsbeläge')"),
        country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
        in_stock: z.boolean().optional().default(true).describe("Only return in-stock products (default true)"),
        max_results: z.number().int().min(1).max(20).optional().default(10).describe("Max results (1–20, default 10)"),
        shop: z.string().optional().describe("Restrict results to a single supported shop (by id or name)"),
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
        })),
        total_results: z.number(),
        // B-163/B-162 rollout: openai profile gets a user-CHOICE next_steps shape
        // (no EAN array) + disclosure + tell_user. claude keeps the exact main
        // next_steps schema (tool/hint/eans?) → byte-identical.
        ...(renderProfile === 'openai'
          ? {
              next_steps: z.array(z.object({
                type: z.string(),
                tool: z.string(),
                hint: z.string(),
                note: z.string().optional(),
              })).optional(),
              disclosure: z.string(),
              tell_user: z.string(),
            }
          : {
              next_steps: z.array(z.object({
                tool: z.string(),
                hint: z.string(),
                eans: z.array(z.string()).optional(),
              })).optional(),
            }),
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
        // Feed-only mode: ask the API to skip scraping shops so results fill correctly.
        if (feedOnly) params.set('feedOnly', 'true');
        const data = await apiJson<{ results?: ProductSearchResult[]; total?: number; error?: string }>(`/api/products/search?${params}`);

        // Defensive client-side filter (the API feedOnly flag already excludes scraping rows).
        const filtered = feedOnly && data.results
          ? data.results.filter(p => FEED_SHOP_IDS.has(p.shop_id))
          : (data.results ?? []);

        // B-163 clamp: openai profile returns at most 8 results regardless of the
        // requested max_results. The input zod schema is unchanged (no reconnect).
        // On the claude profile `results` === `filtered`, so output is byte-identical to main.
        const results = renderProfile === 'openai' ? filtered.slice(0, 8) : filtered;

        if (results.length === 0) {
          return {
            ...mcpText(`No products found for "${q}" in ${country}.${footer(renderProfile)}`),
            structuredContent: {
              query: q,
              results: [],
              total_results: 0,
              ...(renderProfile === 'openai'
                ? { disclosure: footer(renderProfile), tell_user: TELL_USER_SEARCH }
                : {}),
            },
          };
        }

        const total = feedOnly ? results.length : (data.total ?? results.length);

        const lines = results.map((p, i) => {
          const stockIcon = p.in_stock ? "✅" : "❌";
          const link = buildGoUrl(p.shop_id, p.ean ?? null, 'search_product');
          return productEntry(
            renderProfile,
            `${i + 1}. `,
            `${p.product_name} — ${p.shop}`,
            link,
            ` — **${formatEuro(p.price)}** ${stockIcon}${p.ean ? ` · EAN ${p.ean}` : ""}`,
          );
        });

        return {
          ...mcpText(
            `## Product Search: "${q}" (${country})\n\nFound ${total} result(s):\n\n${lines.join("\n\n")}\n\n${PRESENT_LIST_DIRECTIVE}\n\n${linksDirective(renderProfile)}${DISCLOSURE_DIRECTIVE}\n\n💡 Next steps: call get_best_price(ean) to compare prices across all ${shopCount} shops, or optimize_cart(eans: [...]) to find the cheapest total for multiple products including shipping.${footer(renderProfile)}`
          ),
          structuredContent: {
            query: q,
            results: results.map(p => ({
              name: p.product_name,
              ean: p.ean ?? "",
              brand: p.brand ?? undefined,
              price: p.price,
              currency: "EUR",
              shop: p.shop,
              availability: p.in_stock ? "in_stock" : "out_of_stock",
              affiliate_url: buildGoUrl(p.shop_id, p.ean ?? null, 'search_product'),
            })),
            total_results: total,
            ...(renderProfile === 'openai'
              ? {
                  // B-163 redesign: user-choice next_steps, no EAN array. get_best_price
                  // takes exactly one EAN per call, so we offer it as a choice instead of
                  // pre-binding 8/20 EANs to a single call.
                  next_steps: [
                    { type: "refine", tool: "search_product", hint: "Suche mit mehr Details verfeinern (Marke, Modell, Maße)" },
                    { type: "price_check", tool: "get_best_price", hint: "Preis eines gewählten Treffers über alle Shops vergleichen", note: "genau eine EAN pro Aufruf" },
                  ],
                  disclosure: footer(renderProfile),
                  tell_user: TELL_USER_SEARCH,
                }
              : {
                  next_steps: [
                    { tool: "get_best_price", hint: `Compare prices across all ${shopCount} shops`, eans: results.map(p => p.ean).filter((e): e is string => !!e) },
                    { tool: "optimize_cart", hint: "Find cheapest total including shipping for multiple products" },
                  ],
                }),
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
      description: "Look up a single product by its EAN barcode and return the price at every shop that carries it, sorted cheapest-first, with stock status and direct purchase links.",
      inputSchema: {
        ean: z.string().regex(/^\d{8,14}$/).describe("EAN barcode (8–14 digits, e.g. '4524667749493')"),
        country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
        reference_shop: z.string().optional().describe("Shop id or display name to compare against. When set, the response states how much cheaper the cheapest shop is vs. this shop."),
      },
      outputSchema: {
        ean: z.string(),
        product_name: z.string(),
        prices: z.array(z.object({
          shop: z.string(),
          price: z.number(),
          currency: z.string(),
          availability: z.string().optional(),
          affiliate_url: z.string().describe("Direct link to buy at this shop. Always show this URL to the user."),
        })),
        cheapest_shop: z.string(),
        cheapest_price: z.number(),
        next_step: z.object({
          tool: z.string(),
          hint: z.string(),
          eans: z.array(z.string()).optional(),
        }).optional(),
        reference_comparison: z.object({
          reference_shop: z.string(),
          reference_price: z.number(),
          saving: z.number(),
          saving_percent: z.number().optional(),
        }).optional(),
        // B-162 pilot: openai profile only. Spread adds nothing on the claude
        // profile, so the claude outputSchema stays byte-identical to main.
        ...(renderProfile === 'openai'
          ? { disclosure: z.string(), tell_user: z.string() }
          : {}),
      },
      annotations: TOOL_HINTS,
    },
    async ({ ean, country, reference_shop }) => {
      trackMcpEvent("MCP Best Price", { ean });
      console.info(`[MCP] get_best_price: ean=${ean} country=${country}`);
      try {
        const data = await apiJson<{ ean?: string; results?: EanResult[]; total?: number; cheapest?: EanResult | null; error?: string; scraping_pending?: boolean; pending_shops?: string[] }>(`/api/products/${ean}?country=${country}`);

        // Feed-only mode: drop scraping-shop rows. Loss-less list filter; cheapest
        // is recomputed from the filtered (still cheapest-first) list.
        const results = feedOnly && data.results
          ? data.results.filter(r => FEED_SHOP_IDS.has(r.shop_id))
          : (data.results ?? []);

        // B-196: 2-call warm directive. Claude profile only (feedOnly===false) — the
        // openai/feed-only profile has no scraping shops, so scraping_pending is moot
        // and the directive must never appear there.
        const warmingDirective = !feedOnly && data.scraping_pending ? WARMING_REFRESH_DIRECTIVE : '';

        if (results.length === 0) {
          return {
            ...mcpText(
              `No results found for EAN ${ean} in ${country}. The product may not be carried by any supported shop.${warmingDirective}${footer(renderProfile)}`
            ),
            structuredContent: {
              ean,
              product_name: "Unknown",
              prices: [],
              cheapest_shop: "",
              cheapest_price: 0,
              ...(renderProfile === 'openai'
                ? { disclosure: footer(renderProfile), tell_user: PILOT_TELL_USER_BEST_PRICE }
                : {}),
            },
          };
        }

        const cheapest = results[0]!;
        // B-169: the 🏆 / "best price" must go to the cheapest IN-STOCK shop, not the
        // cheapest by price alone. results is price-sorted, so the first in-stock row is
        // the cheapest available offer. null = every shop is out of stock (no trophy).
        const cheapestInStock = results.find(r => r.in_stock) ?? null;
        const productName = cheapest.product_name ?? "Product";
        const lines = results.map((r, i) => {
          const stockIcon = r.in_stock ? "✅" : "❌";
          const trophy = cheapestInStock && r === cheapestInStock ? " 🏆" : "";
          const link = buildGoUrl(r.shop_id, ean, 'get_best_price');
          return productEntry(
            renderProfile,
            `${i + 1}. `,
            `${productName} — ${r.shop}`,
            link,
            `${trophy} — **${formatEuro(r.price)}** ${stockIcon}`,
          );
        });

        const refEntry = reference_shop
          ? results.find(r => r.shop_id === reference_shop || r.shop.toLowerCase() === reference_shop.toLowerCase())
          : undefined;

        let referenceLine = '';
        let referenceComparison: { reference_shop: string; reference_price: number; saving: number; saving_percent?: number } | undefined;
        // B-169: compare against the cheapest IN-STOCK shop (the buyable winner), not the
        // cheapest-by-price row. Skip entirely when every shop is out of stock.
        if (refEntry && cheapestInStock) {
          if (refEntry.shop_id !== cheapestInStock.shop_id) {
            const saving = refEntry.price - cheapestInStock.price;
            const savingPct = (saving / refEntry.price) * 100;
            const savingPctStr = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(savingPct) + ' %';
            referenceLine = `\n\n**${refEntry.shop}: ${formatEuro(refEntry.price)} — günstiger bei ${cheapestInStock.shop}: ${formatEuro(cheapestInStock.price)} (${formatEuro(saving)} / ${savingPctStr} günstiger).**`;
            referenceComparison = {
              reference_shop: refEntry.shop,
              reference_price: refEntry.price,
              saving,
              saving_percent: Math.round(savingPct * 10) / 10,
            };
          } else {
            referenceLine = `\n\n**${refEntry.shop} ist bereits der günstigste Shop für dieses Produkt.**`;
          }
        }

        // B-169: human-readable winner line. The in-stock winner is crowned; when every
        // shop is out of stock, state that plainly and crown nobody.
        const bestPriceLine = cheapestInStock
          ? `**Best price: ${formatEuro(cheapestInStock.price)} at ${cheapestInStock.shop}**`
          : `**Currently out of stock at every shop listed — no in-stock best price available.**`;

        return {
          ...mcpText(
            `## Best Price: ${productName}\n\nEAN: ${ean} · ${country}\n\n${lines.join("\n\n")}\n\n${bestPriceLine}${referenceLine}${warmingDirective}\n\n${linksDirective(renderProfile)}${DISCLOSURE_DIRECTIVE}\n\n## Cart Optimization\nTo find the cheapest combination for multiple products, call:\n\`optimize_cart(eans: ["${ean}", "...other EANs..."])\`${footer(renderProfile)}`
          ),
          structuredContent: {
            ean,
            product_name: productName,
            prices: results.map(r => ({
              shop: r.shop,
              price: r.price,
              currency: "EUR",
              availability: r.in_stock ? "in_stock" : "out_of_stock",
              affiliate_url: buildGoUrl(r.shop_id, ean, 'get_best_price'),
            })),
            cheapest_shop: cheapestInStock ? cheapestInStock.shop : "",
            cheapest_price: cheapestInStock ? cheapestInStock.price : 0,
            next_step: { tool: "optimize_cart", hint: "Find cheapest total including shipping for multiple products", eans: [ean] },
            reference_comparison: referenceComparison,
            ...(renderProfile === 'openai'
              ? { disclosure: footer(renderProfile), tell_user: PILOT_TELL_USER_BEST_PRICE }
              : {}),
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
      description: "Find the cheapest way to buy multiple products together: computes the optimal split across shops — which items to order from which shop — accounting for each shop's shipping costs and free-shipping thresholds, and returns the lowest achievable total including shipping. Takes an array of EAN barcodes. For accurate results, call get_best_price for each EAN first, then call optimize_cart.",
      inputSchema: {
        eans: z
          .array(z.string().regex(/^\d{8,14}$/, "Must be a numeric EAN (8–14 digits)"))
          .min(1)
          .max(20)
          .describe("Array of EAN barcodes (8–14 digit numbers as strings, e.g. '4524667749493'). NOT URLs."),
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
        stale_cache_warning: z.object({
          eans_to_refresh: z.array(z.string()),
          suggestion: z.string(),
        }).optional(),
        // B-162 pilot: openai profile only. Spread is empty on the claude
        // profile, so the claude outputSchema stays byte-identical to main.
        ...(renderProfile === 'openai'
          ? {
              disclosure: z.string(),
              tell_user: z.string(),
              savings: z.object({
                amount: z.number(),
                percent: z.number().nullable().optional(),
                baseline_type: z.string().optional(),
              }).optional(),
              single_shop_option: z.object({
                shop: z.string(),
                total: z.number(),
                delta_percent: z.number(),
                delta_euro: z.number(),
                message: z.string(),
                // B-164c: per-position breakdown (same source the content loop
                // consumes) so the programmatic openai channel gets each item's
                // EAN + /go/ purchase link, not just the shop total.
                items: z.array(z.object({
                  name: z.string(),
                  ean: z.string().optional(),
                  price: z.number(),
                  affiliate_url: z.string().describe("Direct link to buy this item at the single shop. Always show this URL to the user."),
                })).optional(),
              }).optional(),
            }
          : {}),
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
          // Feed-only mode: the API skips scraping shops AND the stale-prices gate,
          // so optimization runs over feed shops only and is never blocked by them.
          body: JSON.stringify(feedOnly ? { eans, country, feedOnly: true } : { eans, country }),
        });

        if (!data.success || !data.result) {
          if (data.error === 'missing_prices' && data.missing_eans?.length) {
            const callList = data.missing_eans.map((e: string) => `- get_best_price(ean: "${e}")`).join('\n');
            let msg =
              `Keine Preisdaten für EAN(s): ${data.missing_eans.join(', ')}\n\n` +
              `💡 Bitte zuerst get_best_price für jede fehlende EAN aufrufen, um die Preise zu laden. Danach optimize_cart erneut starten:\n${callList}`;
            if (data.not_available_eans?.length) {
              msg += `\n\nℹ️ Folgende EANs sind in keinem der unterstützten Shops verfügbar: ${data.not_available_eans.join(', ')}`;
            }
            return mcpError(msg + footer(renderProfile));
          }
          if (data.error === 'not_available' && data.not_available_eans?.length) {
            return mcpError(
              `Die angegebenen Produkte sind in keinem der unterstützten Shops verfügbar: ${data.not_available_eans.join(', ')}` +
              footer(renderProfile)
            );
          }
          if (data.error === 'stale_prices') {
            const toRefresh = data.eans_to_refresh?.length ? data.eans_to_refresh : eans;
            const callList = toRefresh.map((e: string) => `\`get_best_price(ean="${e}")\``).join('\n');
            return mcpError(
              `Some prices for your items need to be refreshed before I can calculate the cheapest combination. ` +
              `Please refresh them first by calling get_best_price for each of these items, ` +
              `then call optimize_cart again with the complete EAN list:\n\n${callList}\n\n` +
              `Important: do this refresh only ONCE. If optimize_cart still reports this after you have already ` +
              `refreshed these items, do NOT repeat the cycle — instead tell the user that prices for ` +
              `these items are not available right now and present the best result you already have.` +
              footer(renderProfile)
            );
          }
          let msg = `Could not optimize cart: ${data.error ?? "No shops found for any of the provided EANs."}`;
          if (data.eans_skipped?.length) {
            msg += `\n\nSkipped EANs (no shops found): ${data.eans_skipped.join(", ")}`;
            msg += `\n\n💡 These EANs may not be carried by any supported shop.`;
          }
          return mcpError(msg + footer(renderProfile));
        }

        const { result } = data;
        let md = `## Cart Optimization (${country})\n\n`;

        if (data.eans_skipped?.length) {
          md += `⚠️ No shops found for EAN(s): ${data.eans_skipped.join(", ")} — these products may not be carried by any supported shop.\n\n`;
        }
        if (data.not_available_eans?.length) {
          md += `ℹ️ Folgende EANs sind in keinem unterstützten Shop verfügbar: ${data.not_available_eans.join(", ")}\n\n`;
        }
        if (data.stale_cache_warning) {
          const { eans_to_refresh } = data.stale_cache_warning;
          md += `⚠️  Note: Prices for some shops weren't available yet for EAN(s): ${eans_to_refresh.join(", ")}. For the most accurate result, call get_best_price for these EANs first, then call optimize_cart again: ${eans_to_refresh.join(", ")}\n\n`;
        }

        md += `### Optimal Shop Split\n`;
        for (const order of result.orders) {
          md += `\n**${order.shopName}** — products ${formatEuro(order.subtotal)} + shipping ${formatEuro(order.shippingCost)} = ${formatEuro(order.total)}\n`;
          for (const item of order.products) {
            const itemLink = buildGoUrl(DISPLAY_NAME_TO_SLUG[order.shopName] ?? null, item.ean ?? null, 'optimize_cart');
            md += productEntry(
              renderProfile,
              `  - `,
              `${item.productName} — ${order.shopName}`,
              itemLink,
              ` — **${formatEuro(item.price)}**`,
              `    `,
            ) + `\n`;
          }
        }

        const baselineLabel = result.baselineType === 'source_shops'
          ? "vs. your selected shops"
          : "vs. buying each item at its cheapest individual shop";

        md += `\n**Total cost: ${formatEuro(result.totalCost)}** (incl. ${formatEuro(result.totalShipping)} shipping)`;
        if (result.savings !== null && result.savings > 0) {
          md += ` *(saves ${formatEuro(result.savings)}${result.savingsPercent !== null ? ` / ${formatPercent(result.savingsPercent)}` : ""} ${baselineLabel})*`;
        }
        md += "\n";

        // Single-shop convenience alternative (B-164a). Server gates it to a multi-shop
        // optimum + cheapest single AFFILIATE shop (no price cap), else null — dumb
        // "show if present". The per-item rows carry clickable /go/ links (loc=
        // single_shop_item), rendered exactly like the order-split rows: Markdown on
        // claude, bare URL on openai, identical text in both.
        if (result.singleShopOption) {
          const sso = result.singleShopOption;
          const deltaPercent = Math.round((sso.grandTotal - result.totalCost) / result.totalCost * 100);
          // B-175: pre-format the absolute € delta so the model never has to subtract.
          const deltaEuro = sso.grandTotal - result.totalCost;
          md += `\n💡 Lieber alles aus einem Shop? ${sso.shop} – ${formatEuro(sso.grandTotal)} (${singleShopNur(deltaPercent)}+${formatEuro(deltaEuro)} / ca. +${formatPercent(deltaPercent)} ggü. Optimum, dafür ein Paket)\n`;
          const ssoSlug = DISPLAY_NAME_TO_SLUG[sso.shop] ?? null;
          for (const item of sso.items ?? []) {
            const itemLink = buildGoUrl(ssoSlug, item.ean ?? null, 'single_shop_item');
            md += productEntry(
              renderProfile,
              `  - `,
              `${item.productName} — ${sso.shop}`,
              itemLink,
              ` — **${formatEuro(item.price)}**`,
              `    `,
            ) + `\n`;
          }
        }

        md += `\n**🛒 Direkt bestellen — klick auf die Links und leg die Produkte in den Warenkorb:**\n`;
        for (const order of result.orders) {
          for (const item of order.products) {
            const itemLink = buildGoUrl(DISPLAY_NAME_TO_SLUG[order.shopName] ?? null, item.ean ?? null, 'optimize_cart');
            md += productEntry(
              renderProfile,
              `- `,
              `${item.productName} — ${order.shopName}`,
              itemLink,
              ``,
            ) + `\n`;
          }
        }

        const savingsInfo =
          result.savings !== null && result.savings > 0
            ? `Saves ${formatEuro(result.savings)}${result.savingsPercent !== null ? ` (${formatPercent(result.savingsPercent)})` : ""} ${baselineLabel}`
            : undefined;

        const shops_used = result.orders.map(order => ({
          shop: order.shopName,
          subtotal: order.subtotal,
          shipping: order.shippingCost,
          items: order.products.map(item => ({
            name: item.productName,
            ean: item.ean,
            price: item.price,
            affiliate_url: buildGoUrl(DISPLAY_NAME_TO_SLUG[order.shopName] ?? null, item.ean ?? null, 'optimize_cart'),
          })),
        }));

        // B-164a/B-164c: enrich the single-shop option from data the stub ALREADY
        // has — shop, total, delta_percent, a friendly message, plus the per-item
        // breakdown (sso.items, the same source the content loop at ~693 consumes,
        // returned by the main app since B-164b). openai only; computed here but
        // only referenced in the openai branch below.
        const singleShopOption = result.singleShopOption
          ? (() => {
              const sso = result.singleShopOption!;
              const total = round2(sso.grandTotal);
              const deltaPercent = Math.round((sso.grandTotal - result.totalCost) / result.totalCost * 100);
              // B-175: pre-format the absolute € delta so the model never has to subtract.
              const deltaEuro = sso.grandTotal - result.totalCost;
              const ssoSlug = DISPLAY_NAME_TO_SLUG[sso.shop] ?? null;
              return {
                shop: sso.shop,
                total,
                delta_percent: deltaPercent,
                delta_euro: round2(deltaEuro),
                message: `Lieber alles in einem Shop und weniger Pakete? Bestell alles bei ${sso.shop} für ${formatEuro(total)} – ${singleShopNur(deltaPercent)}+${formatEuro(deltaEuro)} (ca. +${formatPercent(deltaPercent)}) teurer.`,
                items: (sso.items ?? []).map(it => ({
                  name: it.productName,
                  ean: it.ean,
                  price: round2(it.price),
                  affiliate_url: buildGoUrl(ssoSlug, it.ean ?? null, 'single_shop_item'),
                })),
              };
            })()
          : undefined;

        // Claude branch is byte-identical to main. Openai branch (B-162 pilot)
        // rounds every monetary number to 2 decimals and adds the structured
        // disclosure / tell_user / savings / single_shop_option fields.
        const structuredContent = renderProfile === 'openai'
          ? {
              optimization: {
                total_cost: round2(result.totalCost - result.totalShipping),
                total_shipping: round2(result.totalShipping),
                grand_total: round2(result.totalCost),
                currency: "EUR",
                shops_used: shops_used.map(o => ({
                  shop: o.shop,
                  subtotal: round2(o.subtotal),
                  shipping: round2(o.shipping),
                  items: o.items.map(it => ({
                    name: it.name,
                    ean: it.ean,
                    price: round2(it.price),
                    affiliate_url: it.affiliate_url,
                  })),
                })),
              },
              savings_info: savingsInfo,
              stale_cache_warning: data.stale_cache_warning
                ? { eans_to_refresh: data.stale_cache_warning.eans_to_refresh, suggestion: data.stale_cache_warning.suggestion }
                : undefined,
              disclosure: footer(renderProfile),
              tell_user: PILOT_TELL_USER_OPTIMIZE_CART,
              savings: result.savings !== null
                ? {
                    amount: round2(result.savings),
                    percent: result.savingsPercent,
                    baseline_type: result.baselineType,
                  }
                : undefined,
              single_shop_option: singleShopOption,
            }
          : {
              optimization: {
                total_cost: result.totalCost - result.totalShipping,
                total_shipping: result.totalShipping,
                grand_total: result.totalCost,
                currency: "EUR",
                shops_used,
              },
              savings_info: savingsInfo,
              stale_cache_warning: data.stale_cache_warning
                ? { eans_to_refresh: data.stale_cache_warning.eans_to_refresh, suggestion: data.stale_cache_warning.suggestion }
                : undefined,
            };

        return {
          ...mcpText(md + "\n" + linksDirective(renderProfile) + footer(renderProfile)),
          structuredContent,
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
      description: "Return an overview of the supported shops, including their shipping cost tiers, free-shipping thresholds, and supported countries (DE and AT).",
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
          // B-165: openai profile only — actual shipping-cost tiers (the
          // amounts already rendered into content). Empty spread on claude.
          ...(renderProfile === 'openai'
            ? {
                tiers_de: z.array(z.object({ min_order_value: z.number(), shipping_cost: z.number() })).optional(),
                tiers_at: z.array(z.object({ min_order_value: z.number(), shipping_cost: z.number() })).optional(),
              }
            : {}),
        })),
        // B-162 rollout: openai profile only. Empty spread on claude → schema
        // byte-identical to main.
        ...(renderProfile === 'openai'
          ? {
              disclosure: z.string(),
              tell_user: z.string(),
              next_step: z.object({ tool: z.string(), hint: z.string() }).optional(),
            }
          : {}),
      },
      annotations: TOOL_HINTS,
    },
    async ({ country }) => {
      trackMcpEvent("MCP Shop Info", {});
      console.info(`[MCP] get_shop_info country=${country ?? "all"}`);
      try {
        const data = await apiJson<{ shops?: Record<string, Record<string, ShippingCountryInfo>>; error?: string }>("/api/shops/shipping");

        const shops = data.shops ?? {};
        // Feed-only mode: drop the 3 scraping shops by their exact shipping_costs
        // table display names (e.g. "Bike-Components" with capital C).
        const shopEntries = Object.entries(shops)
          .filter(([name]) => !feedOnly || !SCRAPING_DISPLAY_NAMES.has(name));
        let md = `## Bikefuchs — Shop Shipping Overview\n\n`;

        for (const [shopName, countries] of shopEntries) {
          md += `### ${shopName}\n`;
          for (const [c, info] of Object.entries(countries)) {
            if (country && c !== country) continue;
            const freeAt =
              info.free_shipping_threshold !== null
                ? `Free from ${formatEuro(info.free_shipping_threshold)}`
                : "No free shipping";
            const tiers = info.tiers
              .map((t) => `${formatEuro(t.min_order_value)}+: ${formatEuro(t.shipping_cost)}`)
              .join(" | ");
            md += `- **${c}**: ${freeAt} — Tiers: ${tiers}\n`;
          }
          md += "\n";
        }

        const structuredShops = shopEntries
          .filter(([, countries]) => !country || countries[country])
          .map(([shopName, countries]) => {
            const de = countries["DE"];
            const at = countries["AT"];
            const shippingLabel = (info: ShippingCountryInfo) =>
              info.free_shipping_threshold !== null
                ? `Free from ${formatEuro(info.free_shipping_threshold)}`
                : "No free shipping";
            return {
              name: shopName,
              country: country ?? "DE",
              shipping_de: de ? shippingLabel(de) : undefined,
              shipping_at: at ? shippingLabel(at) : undefined,
              free_shipping_threshold_de: de?.free_shipping_threshold ?? undefined,
              free_shipping_threshold_at: at?.free_shipping_threshold ?? undefined,
              // B-165: openai profile only — surface the real shipping-cost tiers.
              ...(renderProfile === 'openai'
                ? { tiers_de: de?.tiers ?? undefined, tiers_at: at?.tiers ?? undefined }
                : {}),
            };
          });

        return {
          ...mcpText(md + footer(renderProfile)),
          structuredContent: {
            shops: structuredShops,
            ...(renderProfile === 'openai'
              ? {
                  disclosure: footer(renderProfile),
                  tell_user: TELL_USER_SHOP_INFO,
                  next_step: { tool: "get_shipping_breakdown", hint: "Exakte Versandkosten für einen Shop und Warenwert" },
                }
              : {}),
          },
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
      description: "Return the exact shipping cost for a specific shop, country, and cart value, including all shipping tiers and how much more is needed to reach the next free-shipping threshold.",
      inputSchema: {
        shop: z.string().describe(feedOnly
          ? "Shop name or ID (e.g. 'rosebikes', 'boc24', 'fahrradteile', 'Rose Bikes')"
          : "Shop name or ID (e.g. 'rosebikes', 'boc24', 'bike24', 'fahrradteile', 'Rose Bikes')"),
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
        // B-162 rollout: openai profile only. Empty spread on claude → identical.
        ...(renderProfile === 'openai'
          ? { disclosure: z.string(), tell_user: z.string() }
          : {}),
      },
      annotations: TOOL_HINTS,
    },
    async ({ shop, country, cart_value }) => {
      trackMcpEvent("MCP Shipping", { shop });
      console.info(`[MCP] get_shipping_breakdown: shop="${shop}" country=${country} cart=€${cart_value}`);
      // Feed-only mode: refuse the 3 scraping shops as if unsupported.
      if (feedOnly && SCRAPING_SHOP_INPUTS.has(shop.trim().toLowerCase())) {
        return mcpError(`No shipping data found for shop "${shop}". It is not a supported shop.${footer(renderProfile)}`);
      }
      try {
        const params = new URLSearchParams({ shop, country, cart_value: String(cart_value) });
        const data = await apiJson<ShippingResult>(`/api/shops/shipping?${params}`);

        const total = data.cart_value + data.shipping_cost;
        let md = `## Shipping: ${data.shop} (${country})\n\n`;
        md += `- Cart value: ${formatEuro(data.cart_value)}\n`;
        md += `- Shipping: ${formatEuro(data.shipping_cost)}${data.is_free ? " **(FREE)**" : ""}\n`;
        md += `- **Total: ${formatEuro(total)}**\n`;

        if (data.free_shipping_threshold !== null && !data.is_free) {
          const gap = data.free_shipping_threshold - data.cart_value;
          md += `\n💡 Add ${formatEuro(gap)} more to reach free shipping (threshold: ${formatEuro(data.free_shipping_threshold)})\n`;
        }

        md += `\n**Shipping tiers (${country}):**\n`;
        for (const tier of data.tiers) {
          const active = data.cart_value >= tier.min_order_value ? " ◀ current" : "";
          md += `- From ${formatEuro(tier.min_order_value)}: ${formatEuro(tier.shipping_cost)}${active}\n`;
        }

        return {
          ...mcpText(md + footer(renderProfile)),
          structuredContent: {
            shop: data.shop,
            country: data.country,
            cart_value: data.cart_value,
            shipping_cost: data.shipping_cost,
            free_shipping_threshold: data.free_shipping_threshold ?? undefined,
            currency: "EUR",
            ...(renderProfile === 'openai'
              ? { disclosure: footer(renderProfile), tell_user: TELL_USER_SHIPPING }
              : {}),
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
      description: "Given a product's EAN barcode, return every shop that carries it with prices and availability, sorted cheapest-first.",
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
        // B-162 rollout: openai profile only. Empty spread on claude → identical.
        ...(renderProfile === 'openai'
          ? {
              disclosure: z.string(),
              tell_user: z.string(),
              next_step: z.object({ tool: z.string(), hint: z.string(), eans: z.array(z.string()).optional() }).optional(),
            }
          : {}),
      },
      annotations: TOOL_HINTS,
    },
    async ({ ean, country }) => {
      trackMcpEvent("MCP Alternatives", { ean });
      console.info(`[MCP] find_alternatives_for_product: ean=${ean} country=${country}`);
      try {
        const data = await apiJson<{ ean?: string; results?: EanResult[]; total?: number; cheapest?: EanResult | null; error?: string }>(`/api/products/${ean}?country=${country}`);

        // Feed-only mode: drop scraping-shop rows. Loss-less list filter.
        const results = feedOnly && data.results
          ? data.results.filter(r => FEED_SHOP_IDS.has(r.shop_id))
          : (data.results ?? []);

        if (results.length === 0) {
          return {
            ...mcpText(
              `No shops found carrying EAN ${ean} in ${country}. The product may not be available in any supported shop.${footer(renderProfile)}`
            ),
            structuredContent: {
              ean,
              product_name: "Unknown",
              alternatives: [],
              ...(renderProfile === 'openai'
                ? { disclosure: footer(renderProfile), tell_user: TELL_USER_ALTERNATIVES }
                : {}),
            },
          };
        }

        const productName = results[0]!.product_name ?? "Product";
        // B-169: crown the cheapest IN-STOCK shop (price-sorted list → first in-stock row),
        // not the cheapest by price alone. null = every shop is out of stock (no trophy).
        const cheapestInStock = results.find(r => r.in_stock) ?? null;
        let md = `## Where to Buy: ${productName}\n\nEAN: ${ean} · ${country} · ${results.length} shop(s) carry this product\n\n`;

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const stockIcon = r.in_stock ? "✅" : "❌";
          const trophy = cheapestInStock && r === cheapestInStock ? " 🏆" : "";
          const link = buildGoUrl(r.shop_id, ean, 'find_alternatives');
          md += productEntry(
            renderProfile,
            `${i + 1}. `,
            `${productName} — ${r.shop}`,
            link,
            `${trophy} — **${formatEuro(r.price)}** ${stockIcon}`,
          ) + `\n`;
        }

        if (!cheapestInStock) {
          md += `\n⚠️ Currently out of stock at every shop listed above.\n`;
        }

        md += `\n💡 To optimize a cart, call optimize_cart with eans: ['${ean}'] (add other EANs as needed).\n\n${linksDirective(renderProfile)}`;

        return {
          ...mcpText(md + footer(renderProfile)),
          structuredContent: {
            ean,
            product_name: productName,
            alternatives: results.map(r => ({
              shop: r.shop,
              price: r.price,
              currency: "EUR",
              availability: r.in_stock ? "in_stock" : "out_of_stock",
              affiliate_url: buildGoUrl(r.shop_id, ean, 'find_alternatives'),
            })),
            ...(renderProfile === 'openai'
              ? {
                  disclosure: footer(renderProfile),
                  tell_user: TELL_USER_ALTERNATIVES,
                  next_step: { tool: "optimize_cart", hint: "Find cheapest total including shipping for multiple products", eans: [ean] },
                }
              : {}),
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
      description: "Turn a product page URL from a supported shop into structured product data — EAN barcode, price, stock status, and a purchase link — so the EAN can then be used with get_best_price or optimize_cart.",
      inputSchema: {
        url: z.string().url().describe(feedOnly
          ? "Product page URL from a supported shop (e.g. 'https://www.rosebikes.de/...')"
          : "Product page URL from a supported shop (e.g. 'https://www.bike24.de/p2462871.html')"),
        country: z.enum(["DE", "AT"]).optional().default("DE").describe("Country for pricing (DE or AT, default DE)"),
      },
      outputSchema: {
        product_name: z.string(),
        ean: z.string().optional(),
        brand: z.string().optional(),
        price: z.number().optional(),
        shop: z.string(),
        affiliate_url: z.string().optional().describe("Affiliate link for this product."),
        // B-044: not_resolved discriminator (additive, optional → resolved path unaffected).
        // Present when the family was found but the exact variant couldn't be determined.
        status: z.string().optional().describe("'not_resolved' when the exact variant could not be determined."),
        resolved: z.boolean().optional(),
        family_url: z.string().optional().describe("Branded /go/ link to the product family page so the user can pick the variant."),
        message: z.string().optional(),
        // B-162 rollout: openai profile only. Empty spread on claude → identical.
        ...(renderProfile === 'openai'
          ? {
              disclosure: z.string(),
              tell_user: z.string(),
              next_step: z.object({
                tool: z.string(),
                hint: z.string(),
                ean: z.string().optional(),
                reference_shop: z.string().optional(),
              }).optional(),
            }
          : {}),
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
          // Feed-only mode: the API rejects scraping-shop URLs and never lists the
          // 3 scraping shops in its "unsupported URL" error text.
          body: JSON.stringify(feedOnly ? { url, country, feedOnly: true } : { url, country }),
        }, 25000);

        if (data.error) {
          return mcpError(`Could not resolve product: ${data.error}${footer(renderProfile)}`);
        }

        // B-044: family found but the exact variant couldn't be determined. NOT an error —
        // relay a calm "open the product and pick the variant" message with the family link.
        if (data.status === 'not_resolved') {
          const pn = data.product_name ?? 'Das Produkt';
          const msg = data.message ?? `${pn} gefunden – Variante nicht eindeutig, bitte auf der Shop-Seite wählen und Link erneut einfügen.`;
          const link = data.family_url ? `\n\n${data.family_url}` : '';
          // content → Claude (reads ONLY content). structuredContent → ChatGPT + schema validation
          // (the tool has an outputSchema, so a non-error response MUST carry structuredContent).
          return {
            ...mcpText(`## Variante wählen\n\n${msg}${link}${footer(renderProfile)}`),
            structuredContent: {
              product_name: pn,                 // required (string)
              shop: data.shop ?? 'Rose Bikes',  // required (string)
              status: 'not_resolved',
              resolved: false,
              family_url: data.family_url,
              message: msg,
              ...(renderProfile === 'openai'
                ? { disclosure: footer(renderProfile), tell_user: msg }
                : {}),
            },
          };
        }

        // Defensive: never surface a scraping shop even if the API resolved one.
        if (feedOnly && data.shop_id && SCRAPING_SHOP_IDS.has(data.shop_id)) {
          return mcpError(`Could not resolve product: this URL is not from a supported shop.${footer(renderProfile)}`);
        }

        const stockIcon = data.in_stock ? "✅ In stock" : "❌ Out of stock";
        // Only ever emit a /go/ affiliate link — never the raw shop URL. When no
        // shop_id (link empty), render the title without a hyperlink.
        const link = buildGoUrl(data.shop_id, data.ean ?? null, 'resolve_product');
        const title = `${data.product_name ?? "Product"} — ${data.shop}`;
        let md = `## Resolved Product\n\n`;
        md += renderProfile === 'openai'
          ? `${title} — **${formatEuro(data.price)}** ${stockIcon}${link ? `\n   ${link}` : ""}\n\n`
          : `${link ? `[${title}](${link})` : title} — **${formatEuro(data.price)}** ${stockIcon}\n\n`;
        if (data.ean) {
          md += `**EAN:** ${data.ean}\n\n`;
          md += `💡 Next step: call \`get_best_price(ean: "${data.ean}", reference_shop: "${data.shop_id}")\` to compare all shops and see how much cheaper it is vs. ${data.shop}.`;
        } else {
          md += `⚠️ No EAN found for this product — price comparison may not be available.`;
        }

        return {
          ...mcpText(md + footer(renderProfile)),
          structuredContent: {
            product_name: data.product_name ?? "Product",
            ean: data.ean ?? undefined,
            price: data.price,
            shop: data.shop,
            affiliate_url: buildGoUrl(data.shop_id, data.ean ?? null, 'resolve_product') || undefined,
            ...(renderProfile === 'openai'
              ? {
                  disclosure: footer(renderProfile),
                  tell_user: TELL_USER_RESOLVE,
                  ...(data.ean
                    ? { next_step: { tool: "get_best_price", hint: "Preis über alle Shops vergleichen und Ersparnis ggü. diesem Shop zeigen", ean: data.ean, reference_shop: data.shop_id } }
                    : {}),
                }
              : {}),
          },
        };
      } catch (err) {
        return mcpError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  return server;
}

export async function handle(
  req: NextRequest,
  { feedOnly, renderProfile = 'claude' }: { feedOnly: boolean; renderProfile?: RenderProfile },
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createServer({ feedOnly, renderProfile });
  await server.connect(transport);
  const res = await transport.handleRequest(req);

  // Anti-harvesting coverage recording (Chokepoint 2): record the EANs this
  // response served into the source's 24h HLL. The middleware set the source
  // header on allowed requests; allowlisted-AI / fail-open requests have none.
  const source = req.headers.get(RL_SOURCE_HEADER);
  if (source) {
    try {
      const json = await res.clone().json();
      const eans = extractEansFromMcp((json as { result?: { structuredContent?: unknown } })?.result?.structuredContent);
      if (eans.length) await recordCoverage(source, eans);
    } catch {
      /* non-JSON (e.g. SSE/GET) or no structuredContent — nothing to record */
    }
  }

  return res;
}

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
  ean?: string;
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
  baselineType?: 'cheapest_per_item' | 'source_shops';
  // Cheapest single AFFILIATE shop carrying all items (B-164a). Gated server-side to a
  // multi-shop optimum + cheapest affiliate shop (no price cap), else null — render dumb.
  // items[] (B-150b4 + B-164a ean) drives the per-item /go/ links in the content block.
  singleShopOption?: {
    shop: string;
    productsTotal: number;
    shipping: number;
    grandTotal: number;
    items?: { productName: string; price: number; url: string; ean?: string }[];
  } | null;
}

interface OptimizeFromEansResult {
  success: boolean;
  country?: string;
  eans_requested?: string[];
  eans_resolved?: string[];
  eans_skipped?: string[];
  not_available_eans?: string[];
  result: OptimizationResult | null;
  error?: string;
  missing_eans?: string[];
  eans_to_refresh?: string[];
  message?: string;
  hint?: string;
  stale_cache_warning?: {
    eans_to_refresh: string[];
    shops_missing: string[];
    suggestion: string;
  };
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
  // B-044: present when the family was found but the exact variant is undeterminable.
  status?: 'not_resolved';
  message?: string;
  family_url?: string;
}
