/**
 * B-519 test — price age in structuredContent, stale rows never win "best price" when a
 * fresh one exists, and optimize_cart surfaces excluded_stale_offers. Flag:
 * B519_STALE_PRICE_ENABLED (exactly "true"). Flag OFF must be byte-identical to today.
 *
 * Mocks global.fetch so the main app is never called.
 *
 * Run: node --import tsx --test test/b519-stale-price.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import { handle, b519SelectWinner, b519ExcludedLine } from '../app/lib/mcpServer';

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const FLAG = 'B519_STALE_PRICE_ENABLED';
const HOUR = 60 * 60 * 1000;
const STALE_ISO = new Date(Date.now() - 100 * HOUR).toISOString();
const FRESH_ISO = new Date(Date.now() - 1 * HOUR).toISOString();

type Sc = Record<string, any>;
type Rpc = { result?: { content: Array<{ text: string }>; structuredContent?: Sc; isError?: boolean }; error?: unknown };

async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG]; else process.env[FLAG] = value;
  const origInfo = console.info;
  console.info = () => {};
  try { return await fn(); } finally {
    console.info = origInfo;
    if (prev === undefined) delete process.env[FLAG]; else process.env[FLAG] = prev;
  }
}

async function rpc(body: unknown, apiBody: unknown, opts: { feedOnly: boolean; renderProfile?: 'claude' | 'openai' }): Promise<Rpc> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(apiBody), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const res = await handle(
      new Request('http://b519.test/mcp', { method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...(body as object) }) }) as unknown as NextRequest,
      opts,
    );
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
    return JSON.parse(line.replace(/^data: /, ''));
  } finally {
    globalThis.fetch = original;
  }
}

const call = (name: string, args: Record<string, unknown>, apiBody: unknown, opts = { feedOnly: false } as { feedOnly: boolean; renderProfile?: 'claude' | 'openai' }) =>
  rpc({ method: 'tools/call', params: { name, arguments: args } }, apiBody, opts);

const row = (shop_id: string, shop: string, price: number, extra: Sc = {}) => ({
  shop, shop_id, ean: '4026495922944', product_name: 'Testprodukt', brand: null, price, in_stock: true,
  purchase_url: null, product_url: null, affiliate_link: null, image_url: null, ...extra,
});
const EAN = '4026495922944';
const bestPrice = (rows: unknown[], opts?: { feedOnly: boolean; renderProfile?: 'claude' | 'openai' }) =>
  call('get_best_price', { ean: EAN, country: 'DE' }, { ean: EAN, results: rows, total: rows.length }, opts);

// ── pure helper ──────────────────────────────────────────────────────────────
test('[a] b519SelectWinner flag OFF: cheapest eligible wins even if stale', () =>
  withFlag(undefined, async () => {
    const rows = [row('bike-components', 'bike-components', 10, { price_as_of: STALE_ISO }), row('boc24', 'BOC24', 12)];
    const r = b519SelectWinner(rows);
    assert.equal(r.winner?.shop_id, 'bike-components');
    assert.equal(r.allStale, false);
  }));

test('[b] b519SelectWinner flag ON: fresh beats cheaper stale; all-stale keeps cheapest stale', () =>
  withFlag('true', async () => {
    const mixed = [row('bike-components', 'bike-components', 10, { price_as_of: STALE_ISO }), row('boc24', 'BOC24', 12), row('rose', 'ROSE', 13)];
    assert.equal(b519SelectWinner(mixed).winner?.shop_id, 'boc24');
    assert.equal(b519SelectWinner(mixed).allStale, false);
    const allStale = [row('bike-components', 'bike-components', 10, { price_as_of: STALE_ISO }), row('x', 'X', 11, { price_as_of: STALE_ISO })];
    assert.equal(b519SelectWinner(allStale).winner?.shop_id, 'bike-components');
    assert.equal(b519SelectWinner(allStale).allStale, true);
    // out-of-stock rows are never eligible, so they cannot make "allStale" true
    assert.deepEqual(b519SelectWinner([row('a', 'A', 5, { in_stock: false })]), { winner: null, allStale: false });
  }));

test('[c] flag value other than exactly "true" is OFF', () =>
  withFlag('TRUE', async () => {
    const rows = [row('bike-components', 'bike-components', 10, { price_as_of: STALE_ISO }), row('boc24', 'BOC24', 12)];
    assert.equal(b519SelectWinner(rows).winner?.shop_id, 'bike-components');
  }));

// ── get_best_price ───────────────────────────────────────────────────────────
for (const [label, opts] of [
  ['/mcp', { feedOnly: false }],
  ['/mcp/openai', { feedOnly: true, renderProfile: 'openai' as const }],
] as const) {
  test(`[d] get_best_price ${label} flag ON: stale entry flagged, fresh entry wins`, () =>
    withFlag('true', async () => {
      const rows = [
        row('bike-components', 'bike-components', 91.99, { price_as_of: STALE_ISO }),
        row('boc24', 'BOC24', 99.5, { price_as_of: FRESH_ISO }),
        row('rosebikes', 'ROSE Bikes', 105),
      ];
      const out = await bestPrice(rows, opts);
      assert.ok(out.result && !out.result.isError, JSON.stringify(out).slice(0, 400));
      const sc = out.result!.structuredContent!;
      const prices = sc.prices as Sc[];
      const bc = prices.find((p) => p.shop === 'bike-components')!;
      const boc = prices.find((p) => p.shop === 'BOC24')!;
      const rose = prices.find((p) => p.shop === 'ROSE Bikes')!;
      assert.equal(bc.price_as_of, STALE_ISO); assert.equal(bc.price_stale, true);
      assert.equal(boc.price_as_of, FRESH_ISO); assert.ok(!('price_stale' in boc));
      assert.ok(!('price_as_of' in rose) && !('price_stale' in rose), 'no date delivered ⇒ no field');
      assert.equal(sc.cheapest_shop, 'BOC24');
      assert.equal(sc.cheapest_price, 99.5);
      assert.ok(!('cheapest_price_stale' in sc));
      const text = out.result!.content[0]!.text;
      assert.match(text, /\*\*Best price: 99,50 € at BOC24\*\*|Best price: .*BOC24/);
      assert.equal((text.match(/🏆/g) ?? []).length, 1);
      // text note unchanged (B-370): stale row still carries "(Preis vom DD.MM.)"
      assert.match(text, /\(Preis vom \d{2}\.\d{2}\.\)/);
    }));

  test(`[e] get_best_price ${label} flag ON: all eligible stale ⇒ cheapest stale wins + cheapest_price_stale`, () =>
    withFlag('true', async () => {
      const rows = [
        row('bike-components', 'bike-components', 91.99, { price_as_of: STALE_ISO }),
        row('boc24', 'BOC24', 99.5, { price_as_of: STALE_ISO }),
      ];
      const sc = (await bestPrice(rows, opts)).result!.structuredContent!;
      assert.equal(sc.cheapest_shop, 'bike-components');
      assert.equal(sc.cheapest_price, 91.99);
      assert.equal(sc.cheapest_price_stale, true);
    }));

  test(`[f] get_best_price ${label} flag OFF: no new fields, stale cheapest still wins`, () =>
    withFlag(undefined, async () => {
      const rows = [
        row('bike-components', 'bike-components', 91.99, { price_as_of: STALE_ISO }),
        row('boc24', 'BOC24', 99.5),
      ];
      const sc = (await bestPrice(rows, opts)).result!.structuredContent!;
      for (const p of sc.prices as Sc[]) {
        assert.deepEqual(Object.keys(p).sort(), ['affiliate_url', 'availability', 'currency', 'price', 'shop']);
      }
      assert.equal(sc.cheapest_shop, 'bike-components');
      assert.ok(!('cheapest_price_stale' in sc));
    }));

  test(`[g] find_alternatives_for_product ${label} flag ON: same fields + winner rule`, () =>
    withFlag('true', async () => {
      const rows = [row('bike-components', 'bike-components', 91.99, { price_as_of: STALE_ISO }), row('boc24', 'BOC24', 99.5)];
      const out = await call('find_alternatives_for_product', { ean: EAN, country: 'DE' }, { ean: EAN, results: rows, total: 2 }, opts);
      assert.ok(out.result && !out.result.isError, JSON.stringify(out).slice(0, 400));
      const text = out.result!.content[0]!.text;
      const alts = out.result!.structuredContent!.alternatives as Sc[];
      assert.equal(alts[0]!.price_stale, true);
      assert.equal(alts[0]!.price_as_of, STALE_ISO);
      assert.ok(!('price_stale' in alts[1]!));
      // trophy sits on the BOC24 line, not the stale bike-components line
      const lines = text.split('\n');
      assert.ok(!lines.find((l) => l.includes('bike-components') && l.includes('🏆')));
      assert.ok(lines.find((l) => l.includes('BOC24') && l.includes('🏆')));
    }));

  test(`[h] find_alternatives_for_product ${label} flag ON all-stale ⇒ cheapest_price_stale; OFF ⇒ nothing added`, () =>
    withFlag('true', async () => {
      const rows = [row('bike-components', 'bike-components', 91.99, { price_as_of: STALE_ISO })];
      const on = (await call('find_alternatives_for_product', { ean: EAN, country: 'DE' }, { ean: EAN, results: rows, total: 1 }, opts)).result!.structuredContent!;
      assert.equal(on.cheapest_price_stale, true);
      const off = await withFlag(undefined, () => call('find_alternatives_for_product', { ean: EAN, country: 'DE' }, { ean: EAN, results: rows, total: 1 }, opts));
      const osc = off.result!.structuredContent!;
      assert.ok(!('cheapest_price_stale' in osc));
      assert.deepEqual(Object.keys((osc.alternatives as Sc[])[0]!).sort(), ['affiliate_url', 'availability', 'currency', 'price', 'shop']);
    }));
}

test('[i] flag OFF vs ON: text block of get_best_price is identical when no row is stale', async () => {
  const rows = [row('boc24', 'BOC24', 99.5, { price_as_of: FRESH_ISO }), row('rosebikes', 'ROSE Bikes', 105)];
  const off = await withFlag(undefined, () => bestPrice(rows));
  const on = await withFlag('true', () => bestPrice(rows));
  assert.equal(on.result!.content[0]!.text, off.result!.content[0]!.text);
});

// ── optimize_cart ────────────────────────────────────────────────────────────
const OPT_RESULT = {
  orders: [{
    shopName: 'BOC24', subtotal: 99.5, shippingCost: 4.95, total: 104.45,
    products: [{ productName: 'Testprodukt', price: 99.5, ean: EAN, url: null }],
  }],
  totalCost: 104.45, totalShipping: 4.95, savings: null, savingsPercent: null, baselineType: 'cheapest_per_item', singleShopOption: null,
};
const optCall = (extra: Sc, opts = { feedOnly: false } as { feedOnly: boolean; renderProfile?: 'claude' | 'openai' }) =>
  call('optimize_cart', { eans: [EAN], country: 'DE' }, { success: true, result: OPT_RESULT, ...extra }, opts);
const EXCL = { count: 3, shops: ['bike-components'] };

for (const [label, opts] of [
  ['/mcp', { feedOnly: false }],
  ['/mcp/openai', { feedOnly: true, renderProfile: 'openai' as const }],
] as const) {
  test(`[j] optimize_cart ${label} flag ON + excluded_stale_offers: passed through unchanged + one German line`, () =>
    withFlag('true', async () => {
      const out = await optCall({ excluded_stale_offers: EXCL }, opts);
      assert.ok(out.result && !out.result.isError, JSON.stringify(out).slice(0, 400));
      assert.deepEqual(out.result!.structuredContent!.excluded_stale_offers, EXCL);
      const text = out.result!.content[0]!.text;
      const expected = 'Nicht berücksichtigt (Preis älter als 24 Stunden, wird gerade aktualisiert): bike-components. In etwa 30 Sekunden erneut abfragen.';
      assert.equal(b519ExcludedLine(['bike-components']), expected);
      assert.equal(text.split('\n').filter((l) => l === expected).length, 1);
      // after the shop list, before the total line
      assert.ok(text.indexOf(expected) > text.indexOf('**BOC24**'));
      assert.ok(text.indexOf(expected) < text.indexOf('**Total cost'));
    }));

  test(`[k] optimize_cart ${label} flag ON without excluded_stale_offers: nothing added`, () =>
    withFlag('true', async () => {
      const on = await optCall({}, opts);
      const off = await withFlag(undefined, () => optCall({}, opts));
      assert.ok(!('excluded_stale_offers' in on.result!.structuredContent!));
      assert.equal(on.result!.content[0]!.text, off.result!.content[0]!.text);
      assert.deepEqual(on.result!.structuredContent, off.result!.structuredContent);
    }));

  test(`[l] optimize_cart ${label} flag OFF: excluded_stale_offers is dropped exactly as today`, () =>
    withFlag(undefined, async () => {
      const withEx = await optCall({ excluded_stale_offers: EXCL }, opts);
      const without = await optCall({}, opts);
      assert.deepEqual(withEx.result!.structuredContent, without.result!.structuredContent);
      assert.equal(withEx.result!.content[0]!.text, without.result!.content[0]!.text);
      assert.ok(!withEx.result!.content[0]!.text.includes('Nicht berücksichtigt'));
    }));
}

test('[m] multiple shops are joined with ", "', () => {
  assert.equal(
    b519ExcludedLine(['bike-components', 'HiBike']),
    'Nicht berücksichtigt (Preis älter als 24 Stunden, wird gerade aktualisiert): bike-components, HiBike. In etwa 30 Sekunden erneut abfragen.',
  );
});

// ── tools/list ───────────────────────────────────────────────────────────────
test('[n] tools/list: flag ON adds only the optional B-519 schema fields', async () => {
  const list = async (opts: { feedOnly: boolean; renderProfile?: 'claude' | 'openai' }) =>
    (await rpc({ method: 'tools/list', params: {} }, {}, opts)) as { result: { tools: Array<{ name: string; outputSchema: any }> } };
  for (const opts of [{ feedOnly: false }, { feedOnly: true, renderProfile: 'openai' as const }]) {
    const off = await withFlag(undefined, () => list(opts));
    const on = await withFlag('true', () => list(opts));
    const t = (l: typeof off, n: string) => l.result.tools.find((x) => x.name === n)!.outputSchema.properties;
    assert.ok(!('cheapest_price_stale' in t(off, 'get_best_price')));
    assert.ok('cheapest_price_stale' in t(on, 'get_best_price'));
    assert.ok('price_stale' in t(on, 'get_best_price').prices.items.properties);
    assert.ok('price_as_of' in t(on, 'find_alternatives_for_product').alternatives.items.properties);
    assert.ok('excluded_stale_offers' in t(on, 'optimize_cart'));
    assert.ok(!('excluded_stale_offers' in t(off, 'optimize_cart')));
    // none of the new fields is required
    const req = on.result.tools.find((x) => x.name === 'get_best_price')!.outputSchema.required as string[];
    assert.ok(!req.includes('cheapest_price_stale'));
    // every other tool's schema is untouched
    for (const name of ['search_product', 'get_shop_info', 'get_shipping_breakdown', 'resolve_product']) {
      assert.deepEqual(on.result.tools.find((x) => x.name === name), off.result.tools.find((x) => x.name === name));
    }
  }
});
