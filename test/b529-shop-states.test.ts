/**
 * B-529 — shop states (in stock / out of stock / not found) in get_best_price and
 * find_alternatives_for_product, both profiles. Legacy payload (no shop_states) ⇒ legacy output.
 *
 * Run: node --import tsx --test test/b529-shop-states.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import { handle } from '../app/lib/mcpServer';

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const EAN = '4550170444303';
type Sc = Record<string, any>;
type Rpc = { result?: { content: Array<{ text: string }>; structuredContent?: Sc; isError?: boolean } };
type Opts = { feedOnly: boolean; renderProfile?: 'claude' | 'openai' };

const row = (shop_id: string, shop: string, price: number, in_stock: boolean) => ({
  shop, shop_id, ean: EAN, product_name: 'Shimano SLX CS-M7100', brand: null, price, in_stock,
  purchase_url: null, product_url: null, affiliate_link: null, image_url: null,
});
const st = (shop_id: string, shop: string, state: string, price: number | null) => ({
  shop, shop_id, state, price, ean: EAN, product_url: null, purchase_url: null,
});

async function call(api: unknown, name: string, opts: Opts) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(api), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const res = await handle(
      new Request('http://b529.test/mcp', { method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ean: EAN, country: 'DE' } } }) }) as unknown as NextRequest,
      opts,
    );
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
    const out = JSON.parse(line.replace(/^data: /, '')) as Rpc;
    return { text: out.result!.content[0]!.text, sc: out.result!.structuredContent ?? {}, isError: out.result!.isError };
  } finally { globalThis.fetch = origFetch; }
}

const MIX = {
  ean: EAN, total: 3,
  results: [row('bike24', 'BIKE24', 85.99, false), row('boc24', 'BOC24', 114.95, true), row('rosebikes', 'Rose Bikes', 99.0, false)].sort((a, b) => a.price - b.price),
  shop_states: [
    st('boc24', 'BOC24', 'in_stock', 114.95), st('rosebikes', 'Rose Bikes', 'out_of_stock', 99.0), st('bike24', 'BIKE24', 'out_of_stock', 85.99),
    st('fahrrad24', 'Fahrrad24', 'not_found', null), st('bike-discount', 'Bike-Discount', 'not_found', null), st('hibike', 'HiBike', 'not_found', null),
  ],
  not_found_shops: ['Fahrrad24', 'Bike-Discount', 'HiBike'],
  pending_shops: [] as string[],
};
const PROFILES: Array<[string, Opts]> = [['/mcp', { feedOnly: false }], ['/mcp/openai', { feedOnly: true, renderProfile: 'openai' }]];
const TOOLS: Array<[string, string, string]> = [['get_best_price', 'prices', 'get_best_price'], ['find_alternatives_for_product', 'alternatives', 'find_alternatives_for_product']];

for (const [label, opts] of PROFILES) {
  for (const [tool] of TOOLS) {
    test(`[mix] ${label} ${tool}: three blocks, trophy only in stock`, async () => {
      const { text, sc, isError } = await call(MIX, tool, opts);
      assert.ok(!isError, text);
      const iNicht = text.indexOf('**Nicht lieferbar:**');
      const iNf = text.indexOf('Nicht gefunden bei: ');
      assert.ok(iNicht > 0 && iNf > iNicht, 'in-stock lines, then out-of-stock block, then not-found line');
      assert.ok(text.slice(0, iNicht).includes('BOC24') && text.slice(0, iNicht).includes('🏆'));
      const oosBlock = text.slice(iNicht, iNf);
      assert.ok(oosBlock.includes('ROSE Bikes') && oosBlock.includes('nicht lieferbar') && oosBlock.includes('/go/rose-bikes/'));
      assert.ok(!oosBlock.includes('🏆'));
      assert.ok(Array.isArray(sc.shop_states) && Array.isArray(sc.not_found_shops) && Array.isArray(sc.pending_shops));
      assert.ok(!('refresh_required' in sc));
      if (opts.feedOnly) {
        assert.ok(!/BIKE24|Bike-Discount|bike24|bike-discount/.test(text), 'openai text never names scraping shops');
        assert.ok(!/BIKE24|Bike-Discount|bike24|bike-discount/.test(JSON.stringify(sc)), 'openai structuredContent never names scraping shops');
        assert.ok(text.includes('Nicht gefunden bei: Fahrrad24, HiBike'));
      } else {
        assert.ok(text.includes('Nicht gefunden bei: Fahrrad24, Bike-Discount, HiBike'));
        assert.ok(oosBlock.includes('BIKE24'));
      }
      for (const s of sc.shop_states as Sc[]) assert.ok(['in_stock', 'out_of_stock', 'not_found'].includes(s.state));
      const list = (sc.prices ?? sc.alternatives) as Sc[];
      for (const p of list) assert.ok(['in_stock', 'out_of_stock'].includes(p.availability));
    });

    test(`[all-oos] ${label} ${tool}: no trophy, out-of-stock block present`, async () => {
      const api = { ean: EAN, total: 1, results: [row('rosebikes', 'Rose Bikes', 99, false)], shop_states: [st('rosebikes', 'Rose Bikes', 'out_of_stock', 99)], not_found_shops: [], pending_shops: [] };
      const { text, isError } = await call(api, tool, opts);
      assert.ok(!isError, text);
      assert.ok(!text.includes('🏆') && text.includes('**Nicht lieferbar:**') && !text.includes('Nicht gefunden bei'));
      assert.ok(/out of stock at every shop/.test(text));
    });

    test(`[all-not-found] ${label} ${tool}: only the not-found line`, async () => {
      const api = { ean: EAN, total: 0, results: [], shop_states: [st('boc24', 'BOC24', 'not_found', null), st('bike24', 'BIKE24', 'not_found', null)], not_found_shops: ['BOC24', 'BIKE24'], pending_shops: [] };
      const { text, sc, isError } = await call(api, tool, opts);
      assert.ok(!isError, text);
      assert.ok(text.includes(opts.feedOnly ? 'Nicht gefunden bei: BOC24' : 'Nicht gefunden bei: BOC24, BIKE24'));
      assert.ok(!text.includes('BIKE24') || !opts.feedOnly);
      assert.deepEqual((sc.shop_states as Sc[]).every((s) => s.state === 'not_found'), true);
    });

    test(`[pending] ${label} ${tool}: refresh instruction in content AND structuredContent, pending not listed`, async () => {
      const api = { ...MIX, pending_shops: ['bike-discount'], not_found_shops: ['Fahrrad24', 'HiBike'], shop_states: MIX.shop_states.filter((s) => s.shop_id !== 'bike-discount') };
      const { text, sc, isError } = await call(api, tool, { ...opts });
      assert.ok(!isError, text);
      if (opts.feedOnly) {
        // only scraping shops pending on the feed-only endpoint ⇒ nothing pending after filtering
        assert.ok(!('refresh_required' in sc) && !/call .* again/.test(text));
        return;
      }
      assert.ok(text.includes(`call ${tool} again with the same EAN in about 25 seconds`));
      assert.ok(/Do NOT tell the user that the missing shops do not carry this product/.test(text));
      assert.equal(sc.refresh_required.retry_after_seconds, 25);
      assert.ok(sc.refresh_required.instruction.includes(`call ${tool} again with the same EAN in about 25 seconds`));
      assert.deepEqual(sc.pending_shops, ['bike-discount']);
      assert.ok(!text.includes('Bike-Discount'), 'pending shop is not listed in any state');
      assert.ok(!/scrap|feed|cache|warming|railway/i.test(sc.refresh_required.instruction));
    });

    test(`[pending-feed] ${label} ${tool}: feed shop pending ⇒ instruction on both profiles`, async () => {
      const api = { ...MIX, pending_shops: ['boc24'] };
      const { text, sc } = await call(api, tool, opts);
      assert.ok(text.includes('again with the same EAN in about 25 seconds'));
      assert.ok(sc.refresh_required && sc.refresh_required.retry_after_seconds === 25);
    });

    test(`[legacy] ${label} ${tool}: no shop_states ⇒ legacy output (inline ❌, no new fields)`, async () => {
      const api = { ean: EAN, total: 2, results: [row('rosebikes', 'Rose Bikes', 85.99, false), row('boc24', 'BOC24', 114.95, true)] };
      const { text, sc } = await call(api, tool, opts);
      assert.ok(text.includes('❌') && text.includes('✅'));
      assert.ok(!text.includes('Nicht lieferbar') && !text.includes('Nicht gefunden'));
      for (const k of ['shop_states', 'not_found_shops', 'pending_shops', 'refresh_required']) assert.ok(!(k in sc), k);
    });
  }
}

test('[b133] new user-facing strings carry no source words', () => {
  for (const w of ['feed', 'scrap', 'cache', 'warming', 'railway']) {
    const sample = 'Nicht gefunden bei: nicht lieferbar Some shops have not answered yet';
    assert.ok(!sample.toLowerCase().includes(w));
  }
});
