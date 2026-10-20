/**
 * B-519 part 2 test — with B519_STALE_PRICE_ENABLED=true the stub waits and re-fetches when a
 * price is stale (get_best_price, find_alternatives_for_product) or when optimize_cart hits the
 * stale-prices recovery case. At most 2 extra fetches. Flag OFF ⇒ exactly one fetch.
 *
 * The main app is mocked with a per-call reply sequence; the 3 s wait is shortened by the test hook.
 *
 * Run: node --import tsx --test test/b519-part2-refresh.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import { handle, __b519SetRefetchWaitMsForTest } from '../app/lib/mcpServer';

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const FLAG = 'B519_STALE_PRICE_ENABLED';
const HOUR = 60 * 60 * 1000;
const STALE_ISO = new Date(Date.now() - 100 * HOUR).toISOString();
const FRESH_ISO = new Date(Date.now() - 60 * 1000).toISOString();
const EAN = '4026495922944';

type Sc = Record<string, any>;
type Rpc = { result?: { content: Array<{ text: string }>; structuredContent?: Sc; isError?: boolean } };
type Reply = unknown | Error;
type Opts = { feedOnly: boolean; renderProfile?: 'claude' | 'openai' };

const row = (shop_id: string, shop: string, price: number, extra: Sc = {}) => ({
  shop, shop_id, ean: EAN, product_name: 'Testprodukt', brand: null, price, in_stock: true,
  purchase_url: null, product_url: null, affiliate_link: null, image_url: null, ...extra,
});
const products = (bcPrice: number, asOf: string | undefined, extra: unknown[] = [row('boc24', 'BOC24', 50)]) => ({
  ean: EAN, total: 1 + extra.length,
  results: [row('bike-components', 'bike-components', bcPrice, asOf ? { price_as_of: asOf } : {}), ...extra]
    .sort((a: any, b: any) => a.price - b.price),
});

async function run(flag: string | undefined, waitMs: number, replies: Reply[], body: unknown, opts: Opts) {
  const prev = process.env[FLAG];
  if (flag === undefined) delete process.env[FLAG]; else process.env[FLAG] = flag;
  __b519SetRefetchWaitMsForTest(waitMs);
  const origFetch = globalThis.fetch;
  const origInfo = console.info;
  let calls = 0;
  globalThis.fetch = (async () => {
    const r = replies[Math.min(calls, replies.length - 1)];
    calls++;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  console.info = () => {};
  const t0 = Date.now();
  try {
    const res = await handle(
      new Request('http://b519p2.test/mcp', { method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...(body as object) }) }) as unknown as NextRequest,
      opts,
    );
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
    return { out: JSON.parse(line.replace(/^data: /, '')) as Rpc, calls, ms: Date.now() - t0 };
  } finally {
    globalThis.fetch = origFetch; console.info = origInfo;
    __b519SetRefetchWaitMsForTest(3000);
    if (prev === undefined) delete process.env[FLAG]; else process.env[FLAG] = prev;
  }
}
const tool = (name: string, args: Record<string, unknown>) => ({ method: 'tools/call', params: { name, arguments: args } });
const GBP = tool('get_best_price', { ean: EAN, country: 'DE' });
const ALT = tool('find_alternatives_for_product', { ean: EAN, country: 'DE' });
const on = (replies: Reply[], body: unknown, opts: Opts = { feedOnly: false }, waitMs = 20) => run('true', waitMs, replies, body, opts);

const PROFILES: Array<[string, Opts]> = [['/mcp', { feedOnly: false }], ['/mcp/openai', { feedOnly: true, renderProfile: 'openai' }]];

for (const [label, opts] of PROFILES) {
  test(`[a] ${label} get_best_price: stale → fresh on 1st re-fetch (2 fetches, fresh result, no hint)`, async () => {
    const { out, calls } = await on([products(42.99, STALE_ISO), products(42.99, FRESH_ISO)], GBP, opts);
    assert.equal(calls, 2);
    const sc = out.result!.structuredContent!;
    const bc = (sc.prices as Sc[]).find((p) => p.shop === 'bike-components')!;
    assert.equal(bc.price_as_of, FRESH_ISO);
    assert.ok(!('price_stale' in bc));
    assert.equal(sc.cheapest_shop, 'bike-components');
    assert.ok(!('refresh_pending' in sc) && !('retry_after_seconds' in sc) && !('cheapest_price_stale' in sc));
    assert.ok(!out.result!.content[0]!.text.includes('⏳'));
  });

  test(`[b] ${label} get_best_price: stale → stale → fresh on 2nd re-fetch (3 fetches)`, async () => {
    const { out, calls } = await on([products(42.99, STALE_ISO), products(42.99, STALE_ISO), products(43.5, FRESH_ISO)], GBP, opts);
    assert.equal(calls, 3);
    const sc = out.result!.structuredContent!;
    assert.equal(sc.cheapest_price, 43.5);
    assert.ok(!('refresh_pending' in sc));
  });

  test(`[c] ${label} get_best_price: stale → stale → stale ⇒ refresh_pending + hint line, never more than 2 extra fetches`, async () => {
    const { out, calls } = await on([products(42.99, STALE_ISO)], GBP, opts);
    assert.equal(calls, 3, '1 fetch + max 2 re-fetches');
    const sc = out.result!.structuredContent!;
    assert.equal(sc.refresh_pending, true);
    assert.equal(sc.retry_after_seconds, 30);
    // stale bike-components loses the winner to the fresh BOC24 row (part 1 rule still applies)
    assert.equal(sc.cheapest_shop, 'BOC24');
    const d = new Date(STALE_ISO);
    const dm = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
    const expected = `⏳ IMPORTANT — the price of bike-components is being refreshed right now (shown price is from ${dm}). Call get_best_price for this exact EAN ONE more time in about 30 seconds and tell the user you are checking the current price. Do this only ONCE.`;
    const text = out.result!.content[0]!.text;
    assert.equal(text.split('\n').filter((l) => l === expected).length, 1);
  });

  test(`[d] ${label} find_alternatives_for_product: refresh_pending + hint names find_alternatives_for_product`, async () => {
    const { out, calls } = await on([products(42.99, STALE_ISO)], ALT, opts);
    assert.equal(calls, 3);
    const sc = out.result!.structuredContent!;
    assert.equal(sc.refresh_pending, true);
    assert.equal(sc.retry_after_seconds, 30);
    assert.match(out.result!.content[0]!.text, /Call find_alternatives_for_product for this exact EAN ONE more time in about 30 seconds/);
  });

  test(`[e] ${label} no stale entry: no wait, no re-fetch, no new fields`, async () => {
    const { out, calls, ms } = await on([products(42.99, FRESH_ISO)], GBP, opts, 500);
    assert.equal(calls, 1);
    assert.ok(ms < 450, `no wait happened (${ms} ms)`);
    const sc = out.result!.structuredContent!;
    assert.ok(!('refresh_pending' in sc) && !('retry_after_seconds' in sc));
    assert.ok(!out.result!.content[0]!.text.includes('⏳'));
  });

  test(`[f] ${label} re-fetch error ⇒ previous result is used, call does not fail`, async () => {
    const { out, calls } = await on([products(42.99, STALE_ISO), new Error('network down')], GBP, opts);
    assert.equal(calls, 2, 'the failed re-fetch stops the loop');
    assert.ok(!out.result!.isError);
    assert.equal(out.result!.structuredContent!.refresh_pending, true);
    assert.equal(out.result!.structuredContent!.cheapest_shop, 'BOC24');
  });

  test(`[g] ${label} flag OFF: exactly one fetch, nothing added even though a price is stale`, async () => {
    const { out, calls } = await run(undefined, 20, [products(42.99, STALE_ISO), products(42.99, FRESH_ISO)], GBP, opts);
    assert.equal(calls, 1);
    const sc = out.result!.structuredContent!;
    assert.ok(!('refresh_pending' in sc) && !('price_stale' in (sc.prices as Sc[])[0]!));
    assert.ok(!out.result!.content[0]!.text.includes('⏳'));
  });
}

test('[h] default wait is 3000 ms between fetches (one real-time check)', async () => {
  const { calls, ms } = await run('true', 3000, [products(42.99, STALE_ISO), products(42.99, FRESH_ISO)], GBP, { feedOnly: false });
  assert.equal(calls, 2);
  assert.ok(ms >= 2900 && ms < 6000, `waited ~3 s (${ms} ms)`);
});

test('[i] worst case adds exactly 2 waits (3 s each ⇒ 6 s) — checked with a scaled wait', async () => {
  const { calls, ms } = await run('true', 200, [products(42.99, STALE_ISO)], GBP, { feedOnly: false });
  assert.equal(calls, 3);
  assert.ok(ms >= 380, `two waits happened (${ms} ms)`);
});

// ── optimize_cart ────────────────────────────────────────────────────────────
const OPT = tool('optimize_cart', { eans: [EAN], country: 'DE' });
const RECOVERY = { success: false, error: 'stale_prices', eans_to_refresh: [EAN], message: 'stale' };
const OK = {
  success: true, result: {
    orders: [{ shopName: 'bike-components', subtotal: 42.99, shippingCost: 4.99, total: 47.98, products: [{ productName: 'Testprodukt', price: 42.99, ean: EAN, url: null }] }],
    totalCost: 47.98, totalShipping: 4.99, savings: null, savingsPercent: null, baselineType: 'cheapest_per_item', singleShopOption: null,
  },
};

for (const [label, opts] of PROFILES) {
  test(`[j] ${label} optimize_cart: recovery → success on 1st extra call returns the normal result`, async () => {
    const { out, calls } = await on([RECOVERY, OK], OPT, opts);
    assert.equal(calls, 2);
    assert.ok(!out.result!.isError);
    assert.ok(out.result!.structuredContent!.optimization);
    assert.match(out.result!.content[0]!.text, /\*\*Total cost: 47,98\s€\*\*/);
  });

  test(`[k] ${label} optimize_cart: recovery → recovery → success on 2nd extra call`, async () => {
    const { out, calls } = await on([RECOVERY, RECOVERY, OK], OPT, opts);
    assert.equal(calls, 3);
    assert.ok(!out.result!.isError);
  });

  test(`[l] ${label} optimize_cart: recovery ×3 ⇒ the existing recovery message, unchanged, after max 2 extra calls`, async () => {
    const { out, calls } = await on([RECOVERY], OPT, opts);
    assert.equal(calls, 3);
    assert.equal(out.result!.isError, true);
    const flagOff = await run(undefined, 20, [RECOVERY], OPT, opts);
    assert.equal(flagOff.calls, 1);
    assert.equal(out.result!.content[0]!.text, flagOff.out.result!.content[0]!.text, 'recovery text byte-identical to flag OFF');
  });

  test(`[m] ${label} optimize_cart: success on first call ⇒ no re-call; part-1 excluded_stale_offers still passed through`, async () => {
    const { out, calls } = await on([{ ...OK, excluded_stale_offers: { count: 1, shops: ['bike-components'] } }], OPT, opts);
    assert.equal(calls, 1);
    assert.deepEqual(out.result!.structuredContent!.excluded_stale_offers, { count: 1, shops: ['bike-components'] });
  });

  test(`[n] ${label} optimize_cart: other errors (missing_prices) are NOT retried`, async () => {
    const { calls } = await on([{ success: false, error: 'missing_prices', missing_eans: [EAN] }], OPT, opts);
    assert.equal(calls, 1);
  });

  test(`[o] ${label} optimize_cart flag OFF: recovery case is one call, as before`, async () => {
    const { calls } = await run(undefined, 20, [RECOVERY, OK], OPT, opts);
    assert.equal(calls, 1);
  });
}

// ── tools/list ───────────────────────────────────────────────────────────────
test('[p] tools/list flag ON declares refresh_pending / retry_after_seconds as optional on both endpoints', async () => {
  for (const [, opts] of PROFILES) {
    const { out } = await on([{}], { method: 'tools/list', params: {} }, opts);
    const tools = (out as unknown as { result: { tools: Array<{ name: string; outputSchema: any }> } }).result.tools;
    for (const n of ['get_best_price', 'find_alternatives_for_product']) {
      const sch = tools.find((t) => t.name === n)!.outputSchema;
      assert.ok('refresh_pending' in sch.properties && 'retry_after_seconds' in sch.properties);
      assert.ok(!(sch.required as string[]).includes('refresh_pending'));
    }
  }
});
