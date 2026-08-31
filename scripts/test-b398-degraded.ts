/**
 * B-398 acceptance test — the stub must never say "No products found" after a search
 * that did not complete.
 *
 * Drives the REAL exported handle() from app/lib/mcpServer.ts on BOTH channels, with
 * global.fetch stubbed so no network or database is touched. That is the point: the thing
 * under test is the rendered wording, and it must be provable without a live outage.
 *
 * Covers acceptance check 7 (fault tolerance) and re-asserts check 8 (no metadata moved)
 * by comparing tools/list across the two channels.
 *
 * Run: npx tsx scripts/test-b398-degraded.ts
 */
import type { NextRequest } from "next/server";
import { handle } from "../app/lib/mcpServer";

// handle() is typed for NextRequest, but only reads standard Request members here.
const asNext = (r: Request) => r as unknown as NextRequest;

let failures = 0;
function assert(cond: boolean, msg: string, detail = "") {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg} ${detail}`); failures++; }
}

type ApiShape = { results: unknown[]; total: number; degraded?: boolean; degraded_reason?: string };

function stubFetch(body: ApiShape) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

async function callSearch(opts: { feedOnly: boolean; renderProfile?: "claude" | "openai" }) {
  const res = await handle(
    new Request("https://mcp.bikefuchs.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "search_product", arguments: { q: "ION Ellbogenprotektoren" } },
      }),
    }) as unknown as NextRequest,
    opts,
  );
  const j = JSON.parse(await res.text());
  return {
    text: (j?.result?.content?.[0]?.text as string) ?? "",
    structured: (j?.result?.structuredContent ?? {}) as Record<string, unknown>,
  };
}

const CLAUDE = { feedOnly: false } as const;
const OPENAI = { feedOnly: true, renderProfile: "openai" as const };

async function main() {
  console.log("\n[A] degraded + empty — the sentence that would otherwise be a lie");
  stubFetch({ results: [], total: 0, degraded: true, degraded_reason: "product_index_unavailable" });
  for (const [label, opts] of [["claude", CLAUDE], ["openai", OPENAI]] as const) {
    const r = await callSearch(opts);
    assert(!r.text.includes("No products found"), `${label}: does NOT say "No products found"`, `\n      got: ${r.text.slice(0, 160)}`);
    assert(/Produktdatenbank/.test(r.text), `${label}: states the product database could not be searched`);
    assert(/nicht durchsucht werden/.test(r.text), `${label}: says the search did not complete`);
  }
  const oa = await callSearch(OPENAI);
  assert(/could not be searched/i.test(String(oa.structured.tell_user ?? "")), "openai: tell_user carries the degraded instruction");
  assert(!/Present the found products/.test(String(oa.structured.tell_user ?? "")), "openai: tell_user is NOT the normal wording");

  console.log("\n[B] genuinely empty — today's sentence, unchanged");
  stubFetch({ results: [], total: 0 });
  for (const [label, opts] of [["claude", CLAUDE], ["openai", OPENAI]] as const) {
    const r = await callSearch(opts);
    assert(r.text.includes('No products found for "ION Ellbogenprotektoren"'), `${label}: keeps the original sentence`);
    assert(!/Produktdatenbank/.test(r.text), `${label}: no degradation marker when not degraded`);
  }

  console.log("\n[C] degraded + partial — results shown, but flagged incomplete");
  stubFetch({
    results: [{ product_name: "ION E-Lite Pads", ean: "4250450721338", shop: "BIKE24", shop_id: "bike24",
                brand: "ION", price: 39.9, in_stock: true, purchase_url: null, product_url: null,
                affiliate_link: null, image_url: null }],
    total: 1, degraded: true, degraded_reason: "product_index_unavailable",
  });
  const partial = await callSearch(CLAUDE);
  assert(/Unvollständiges Ergebnis/.test(partial.text), "claude: partial result is flagged incomplete");
  assert(/ION E-Lite Pads/.test(partial.text), "claude: the surviving rows are still shown, not discarded");

  console.log("\n[D] metadata guard — 7 tools on both channels, unchanged shape");
  for (const [label, opts] of [["claude", CLAUDE], ["openai", OPENAI]] as const) {
    const res = await handle(
      new Request("https://mcp.bikefuchs.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }) as unknown as NextRequest, opts);
    const tools = JSON.parse(await res.text())?.result?.tools ?? [];
    assert(tools.length === 7, `${label}: still exactly 7 tools`);
    const sp = tools.find((t: { name: string }) => t.name === "search_product");
    assert(!!sp && !("degraded" in (sp.outputSchema?.properties ?? {})),
           `${label}: no 'degraded' field was added to the search_product outputSchema`);
  }

  console.log(`\n=== ${failures === 0 ? "PASS" : `${failures} FAILURES`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
