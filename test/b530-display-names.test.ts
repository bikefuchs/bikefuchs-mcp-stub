/**
 * B-530 — website spelling for shop names in MCP output (render boundary only).
 *
 * The API/optimizer keep internal names (Rose Bikes, Fahrradteile, Hibike, Bike-Components);
 * the stub converts ONLY what a user/model sees. Links, filters and lookups use RAW names/ids.
 *
 * Run: node --import tsx --test test/b530-display-names.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import { handle } from '../app/lib/mcpServer';
import { displayShopName, displayShopInMessage } from '../app/lib/shopDisplayNames';

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const EAN1 = '4550170444303';
const EAN2 = '4524667749493';
type Sc = Record<string, any>;
type Opts = { feedOnly: boolean; renderProfile?: 'claude' | 'openai' };
const CLAUDE: Opts = { feedOnly: false };
const OPENAI: Opts = { feedOnly: true, renderProfile: 'openai' };

// Old spellings as they appear in API / optimizer / shipping_costs payloads.
const OLD = ['Rose Bikes', 'Fahrradteile', 'Hibike', 'Bike-Components'];
const NEW = ['ROSE Bikes', 'fahrrad-teile.shop', 'HiBike', 'bike-components'];

// ── unit: mapping table ────────────────────────────────────────────────────────────────
test('mapping: case variants → website spelling', () => {
  for (const n of ['Rose Bikes', 'rosebikes', 'rose', 'ROSE BIKES', 'ROSE Bikes']) assert.equal(displayShopName(n), 'ROSE Bikes');
  for (const n of ['Fahrradteile', 'fahrradteile', 'FAHRRADTEILE', 'fahrrad-teile.shop']) assert.equal(displayShopName(n), 'fahrrad-teile.shop');
  for (const n of ['Hibike', 'hibike', 'HiBike', 'HIBIKE']) assert.equal(displayShopName(n), 'HiBike');
  for (const n of ['Bike-Components', 'bike-components', 'BIKE-COMPONENTS']) assert.equal(displayShopName(n), 'bike-components');
});
test('mapping: shop_id takes precedence over the name', () => {
  assert.equal(displayShopName('Whatever', 'rosebikes'), 'ROSE Bikes');
  assert.equal(displayShopName('Whatever', 'fahrradteile'), 'fahrrad-teile.shop');
  assert.equal(displayShopName('Rose Bikes', 'boc24'), 'ROSE Bikes', 'id without mapping falls back to the alias');
  assert.equal(displayShopName('Rose Bikes', null), 'ROSE Bikes');
});
test('mapping: unchanged shops and unknown names pass through', () => {
  for (const n of ['BOC24', 'Fahrrad24', 'Bike Mailorder', 'Maciag Offroad', 'fahrrad-xxl', 'BIKE24', 'Bike-Discount', 'Velondo (Fahrrad24)', 'Some Shop', '']) {
    assert.equal(displayShopName(n), n);
  }
  assert.equal(displayShopName('Fahrrad24', 'fahrrad24'), 'Fahrrad24');
});
test('message: only the exact raw shop name of the same response is swapped', () => {
  assert.equal(displayShopInMessage('Das ist bei Fahrradteile lieferbar. Fahrradteile sind toll.', 'Fahrradteile'), 'Das ist bei fahrrad-teile.shop lieferbar. Fahrradteile sind toll.');
  assert.equal(displayShopInMessage('x bei BOC24 y', 'BOC24'), 'x bei BOC24 y');
  assert.equal(displayShopInMessage('x', undefined), 'x');
});

// ── render harness ─────────────────────────────────────────────────────────────────────
type Routes = { search?: unknown; product?: unknown; optimize?: unknown; shippingAll?: unknown; shipping?: (shop: string) => unknown; resolve?: unknown };
async function call(routes: Routes, name: string, args: Record<string, unknown>, opts: Opts) {
  const origFetch = globalThis.fetch;
  const origInfo = console.info;
  console.info = () => {};
  globalThis.fetch = (async (input: unknown) => {
    const u = new URL(typeof input === 'string' ? input : (input as Request).url ?? String(input));
    let body: unknown;
    if (u.pathname === '/api/products/search') body = routes.search;
    else if (u.pathname === '/api/products/resolve') body = routes.resolve;
    else if (u.pathname.startsWith('/api/products/')) body = routes.product;
    else if (u.pathname === '/api/cart/optimize-from-eans') body = routes.optimize;
    else if (u.pathname === '/api/shops/shipping') body = u.searchParams.get('shop') ? routes.shipping!(u.searchParams.get('shop')!) : routes.shippingAll;
    if (body === undefined) return new Response(JSON.stringify({ error: 'no route ' + u.pathname }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const res = await handle(
      new Request('http://b530.test/mcp', { method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }) as unknown as NextRequest,
      opts,
    );
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data: ')) ?? text;
    const out = JSON.parse(line.replace(/^data: /, '')) as { result?: { content: Array<{ text: string }>; structuredContent?: Sc; isError?: boolean } };
    return { text: out.result!.content[0]!.text, sc: out.result!.structuredContent ?? {}, isError: out.result!.isError };
  } finally { globalThis.fetch = origFetch; console.info = origInfo; }
}

const goUrls = (s: string) => [...s.matchAll(/https?:\/\/[^\s)\]"]*\/go\/[^\s)\]"]+/g)].map(m => m[0]).sort();

/** Shop-name occurrences: strip /go/ URLs (slugs legitimately contain "rose-bikes", "hibike", "bike-components"). */
function names(s: string): string {
  return s.replace(/https?:\/\/[^\s)\]"]*\/go\/[^\s)\]"]+/g, '');
}
function assertWebsiteNames(label: string, text: string, sc: Sc, opts: Opts) {
  const t = names(text), j = names(JSON.stringify(sc));
  for (const old of OLD) {
    // "bike-components" is its own new spelling; only the capitalised old form is wrong.
    assert.ok(!t.includes(old), `${label}: content still contains "${old}"`);
    assert.ok(!j.includes(old), `${label}: structuredContent still contains "${old}"`);
  }
  if (opts.feedOnly) {
    assert.ok(!/BIKE24|Bike-Discount|bike24|bike-discount/.test(t + j), `${label}: scraping shop leaked on /mcp/openai`);
  }
}

const prow = (shop_id: string, shop: string, price: number, ean = EAN1) => ({
  shop, shop_id, ean, product_name: 'Shimano SLX CS-M7100', brand: null, price, in_stock: true,
  purchase_url: null, product_url: null, affiliate_link: null, image_url: null,
});
const FEED4 = [prow('rosebikes', 'Rose Bikes', 90), prow('fahrradteile', 'Fahrradteile', 95), prow('hibike', 'Hibike', 99), prow('bike-components', 'Bike-Components', 101)];
const SCRAPE = [prow('bike24', 'BIKE24', 85), prow('bike-discount', 'Bike-Discount', 88)];
const st = (shop_id: string, shop: string, state: string, price: number | null) => ({ shop, shop_id, state, price, ean: EAN1, product_url: null, purchase_url: null });

const PRODUCT = {
  ean: EAN1, total: 4, results: FEED4, cheapest: FEED4[0],
  shop_states: [
    st('rosebikes', 'Rose Bikes', 'in_stock', 90), st('fahrradteile', 'Fahrradteile', 'in_stock', 95),
    st('hibike', 'Hibike', 'out_of_stock', 99), st('bike-components', 'Bike-Components', 'in_stock', 101),
    st('boc24', 'BOC24', 'not_found', null),
  ],
  not_found_shops: ['Fahrradteile', 'Hibike', 'Bike-Components', 'Rose Bikes', 'BOC24'],
  pending_shops: [] as string[],
};
const PRODUCT_WITH_SCRAPING = {
  ...PRODUCT, results: [...FEED4, ...SCRAPE],
  shop_states: [...PRODUCT.shop_states, st('bike24', 'BIKE24', 'in_stock', 85), st('bike-discount', 'Bike-Discount', 'not_found', null)],
  not_found_shops: [...PRODUCT.not_found_shops, 'Bike-Discount'],
};

const order = (shopName: string, ean: string) => ({
  shopName, subtotal: 50, shippingCost: 4.95, total: 54.95,
  products: [{ productName: 'Kette', shopName, price: 50, url: 'https://example.invalid/x', inStock: true, ean }],
});
const OPTIMIZE = {
  success: true, country: 'DE', eans_requested: [EAN1, EAN2], eans_resolved: [EAN1, EAN2],
  result: {
    orders: [order('Rose Bikes', EAN1), order('Fahrradteile', EAN2)],
    totalCost: 109.9, totalShipping: 9.9, savings: 5, savingsPercent: 4.3, baselineType: 'cheapest_per_item',
    singleShopOption: { shop: 'Rose Bikes', productsTotal: 105, shipping: 4.95, grandTotal: 109.95,
      items: [{ productName: 'Kette', price: 50, url: 'https://example.invalid/x', ean: EAN1 }] },
  },
};

const SHIPPING_ALL = {
  shops: {
    'Rose Bikes': { DE: { tiers: [{ min_order_value: 0, shipping_cost: 4.95 }], free_shipping_threshold: null } },
    'Fahrradteile': { DE: { tiers: [{ min_order_value: 0, shipping_cost: 5.9 }], free_shipping_threshold: 150 } },
    'Hibike': { DE: { tiers: [{ min_order_value: 0, shipping_cost: 4.99 }], free_shipping_threshold: null } },
    'Bike-Components': { DE: { tiers: [{ min_order_value: 0, shipping_cost: 4.99 }], free_shipping_threshold: null } },
    'BOC24': { DE: { tiers: [{ min_order_value: 0, shipping_cost: 4.95 }], free_shipping_threshold: null } },
    'BIKE24': { DE: { tiers: [{ min_order_value: 0, shipping_cost: 4.99 }], free_shipping_threshold: null } },
  },
};
const shippingFor = (shop: string) => ({
  shop, country: 'DE', cart_value: 50, shipping_cost: 4.95, is_free: false, free_shipping_threshold: null,
  tiers: [{ min_order_value: 0, shipping_cost: 4.95 }],
});

const RESOLVED = {
  ean: EAN1, product_name: 'Shimano SLX', price: 90, in_stock: true, shop: 'Rose Bikes', shop_id: 'rosebikes',
  purchase_url: null, product_url: 'https://www.rosebikes.de/x',
};

for (const [label, opts] of [['/mcp', CLAUDE], ['/mcp/openai', OPENAI]] as Array<[string, Opts]>) {
  const prod = opts.feedOnly ? PRODUCT : PRODUCT_WITH_SCRAPING;

  test(`${label} search_product`, async () => {
    const r = await call({ search: { results: FEED4.map(x => ({ ...x, ean: EAN1 })), total: 4 } }, 'search_product', { q: 'shimano slx' }, opts);
    assert.ok(!r.isError, r.text);
    assertWebsiteNames('search_product', r.text, r.sc, opts);
    for (const n of NEW) assert.ok(r.text.includes(n) && JSON.stringify(r.sc).includes(n), `search_product shows ${n}`);
  });

  for (const [tool, args] of [['get_best_price', { ean: EAN1, reference_shop: 'rosebikes' }], ['find_alternatives_for_product', { ean: EAN1 }]] as Array<[string, Record<string, unknown>]>) {
    test(`${label} ${tool}`, async () => {
      const r = await call({ product: prod }, tool, args, opts);
      assert.ok(!r.isError, r.text);
      assertWebsiteNames(tool, r.text, r.sc, opts);
      for (const n of NEW) assert.ok(r.text.includes(n), `${tool} content shows ${n}`);
      const states = JSON.stringify(r.sc.shop_states);
      assert.ok(states.includes('ROSE Bikes') && states.includes('fahrrad-teile.shop') && states.includes('HiBike'), 'shop_states[].shop converted');
      assert.ok(r.text.includes('Nicht gefunden bei: ') && r.text.includes('fahrrad-teile.shop, HiBike, bike-components, ROSE Bikes, BOC24'), 'not-found line converted');
      assert.ok(JSON.stringify(r.sc.not_found_shops).includes('fahrrad-teile.shop'), 'not_found_shops converted');
      for (const s of r.sc.shop_states as Sc[]) assert.ok(['rosebikes', 'fahrradteile', 'hibike', 'bike-components', 'boc24', 'bike24', 'bike-discount'].includes(s.shop_id), 'shop_id untouched');
      if (tool === 'get_best_price') {
        assert.equal(r.sc.cheapest_shop, 'ROSE Bikes');
        assert.equal(r.sc.reference_comparison, undefined, 'reference = winner → no comparison object');
        assert.ok(r.text.includes('ROSE Bikes ist bereits der günstigste Shop'), 'reference_shop compared by RAW id/name, rendered converted');
      }
    });
  }

  test(`${label} get_best_price reference_shop compare + comparison line`, async () => {
    const r = await call({ product: prod }, 'get_best_price', { ean: EAN1, reference_shop: 'fahrradteile' }, opts);
    assert.ok(!r.isError, r.text);
    assertWebsiteNames('gbp-ref', r.text, r.sc, opts);
    assert.ok(/fahrrad-teile\.shop: .* — günstiger bei ROSE Bikes:/.test(r.text), r.text);
    assert.equal(r.sc.reference_comparison?.reference_shop, 'fahrrad-teile.shop');
  });

  test(`${label} optimize_cart`, async () => {
    const r = await call({ optimize: OPTIMIZE }, 'optimize_cart', { eans: [EAN1, EAN2] }, opts);
    assert.ok(!r.isError, r.text);
    assertWebsiteNames('optimize_cart', r.text, r.sc, opts);
    assert.ok(r.text.includes('**ROSE Bikes** — products') && r.text.includes('**fahrrad-teile.shop** — products'));
    assert.ok(r.text.includes('Lieber alles aus einem Shop? ROSE Bikes'));
    const used = (r.sc.optimization.shops_used as Sc[]).map(s => s.shop);
    assert.deepEqual(used, ['ROSE Bikes', 'fahrrad-teile.shop']);
    // links keep the RAW-name → slug lookup (website spelling must not change a slug)
    const links = goUrls(r.text);
    assert.ok(links.some(u => u.includes(`/go/rose-bikes/${EAN1}`)) && links.some(u => u.includes(`/go/fahrrad-teile-shop/${EAN2}`)), links.join('\n'));
    if (opts.renderProfile === 'openai') assert.equal(r.sc.single_shop_option.shop, 'ROSE Bikes');
  });

  test(`${label} optimize_cart excluded_stale_offers + savings lines`, async () => {
    const prev = process.env.B519_STALE_PRICE_ENABLED;
    process.env.B519_STALE_PRICE_ENABLED = 'true';
    try {
      const api = { ...OPTIMIZE, excluded_stale_offers: { count: 2, shops: ['Bike-Components', 'Hibike'] } };
      const r = await call({ optimize: api }, 'optimize_cart', { eans: [EAN1, EAN2] }, opts);
      assert.ok(!r.isError, r.text);
      assertWebsiteNames('optimize_cart-stale', r.text, r.sc, opts);
      assert.ok(r.text.includes('bike-components, HiBike'));
      assert.deepEqual(r.sc.excluded_stale_offers.shops, ['bike-components', 'HiBike']);
    } finally { if (prev === undefined) delete process.env.B519_STALE_PRICE_ENABLED; else process.env.B519_STALE_PRICE_ENABLED = prev; }
  });

  test(`${label} get_shop_info`, async () => {
    const r = await call({ shippingAll: SHIPPING_ALL }, 'get_shop_info', {}, opts);
    assert.ok(!r.isError, r.text);
    assertWebsiteNames('get_shop_info', r.text, r.sc, opts);
    for (const n of NEW) assert.ok(r.text.includes(`### ${n}`), `get_shop_info heading ${n}`);
    assert.deepEqual((r.sc.shops as Sc[]).map(s => s.name).filter(n => NEW.includes(n)).sort(), [...NEW].sort());
    if (opts.feedOnly) assert.ok(!r.text.includes('BIKE24'), 'filter still applied on the RAW table name');
    else assert.ok(r.text.includes('### BIKE24'));
  });

  test(`${label} get_shipping_breakdown`, async () => {
    for (const [i, old] of OLD.entries()) {
      const r = await call({ shipping: shippingFor }, 'get_shipping_breakdown', { shop: old, country: 'DE', cart_value: 50 }, opts);
      assert.ok(!r.isError, r.text);
      assertWebsiteNames('get_shipping_breakdown', r.text, r.sc, opts);
      assert.ok(r.text.includes(`## Shipping: ${NEW[i]} (DE)`), r.text);
      assert.equal(r.sc.shop, NEW[i]);
    }
  });

  test(`${label} resolve_product (resolved + not_resolved + fallback + pick_variant)`, async () => {
    let r = await call({ resolve: RESOLVED }, 'resolve_product', { url: 'https://www.rosebikes.de/x' }, opts);
    assert.ok(!r.isError, r.text);
    assertWebsiteNames('resolve resolved', r.text, r.sc, opts);
    assert.equal(r.sc.shop, 'ROSE Bikes');
    assert.ok(r.text.includes('Shimano SLX — ROSE Bikes') && r.text.includes('vs. ROSE Bikes.'));
    assert.ok(r.text.includes('reference_shop: "rosebikes"'), 'reference_shop arg stays the raw id');

    r = await call({ resolve: { ...RESOLVED, shop: 'Fahrradteile', shop_id: 'fahrradteile' } }, 'resolve_product', { url: 'https://www.fahrrad-teile.shop/x' }, opts);
    assert.equal(r.sc.shop, 'fahrrad-teile.shop');

    r = await call({ resolve: { ...RESOLVED, shop: 'Fahrradteile', shop_id: 'fahrradteile', status: 'not_resolved', family_url: 'https://www.fahrrad-teile.shop/f', message: 'Kette ist bei Fahrradteile lieferbar. Direkt zum Produkt:' } }, 'resolve_product', { url: 'https://www.fahrrad-teile.shop/x' }, opts);
    assert.ok(!r.isError, r.text);
    assert.equal(r.sc.shop, 'fahrrad-teile.shop');
    assert.ok(r.text.includes('ist bei fahrrad-teile.shop lieferbar'), r.text);

    // not_resolved fallback (no shop in the payload)
    r = await call({ resolve: { status: 'not_resolved', product_name: 'X', family_url: 'https://www.rosebikes.de/f' } }, 'resolve_product', { url: 'https://www.rosebikes.de/x' }, opts);
    assert.equal(r.sc.shop, 'ROSE Bikes');

    r = await call({ resolve: { ...RESOLVED, status: 'pick_variant', axis: 'size', shop: 'Rose Bikes', shop_id: 'rosebikes', options: [{ ean: EAN1, size: 'M', colour: null, price: 90, in_stock: true }] } }, 'resolve_product', { url: 'https://www.rosebikes.de/x' }, opts);
    assert.ok(!r.isError, r.text);
    assert.equal(r.sc.shop, 'ROSE Bikes');
  });
}

// ── /mcp/openai: scraping shops are still never visible ─────────────────────────────────
test('/mcp/openai: BIKE24 / Bike-Discount never appear (filters use RAW ids/names)', async () => {
  for (const [tool, args, routes] of [
    ['get_best_price', { ean: EAN1 }, { product: PRODUCT_WITH_SCRAPING }],
    ['find_alternatives_for_product', { ean: EAN1 }, { product: PRODUCT_WITH_SCRAPING }],
    ['search_product', { q: 'shimano slx' }, { search: { results: [...FEED4, ...SCRAPE], total: 6 } }],
    ['get_shop_info', {}, { shippingAll: SHIPPING_ALL }],
  ] as Array<[string, Record<string, unknown>, Routes]>) {
    const r = await call(routes, tool, args, OPENAI);
    assert.ok(!/BIKE24|Bike-Discount|bike24|bike-discount/.test(names(r.text) + names(JSON.stringify(r.sc))), `${tool}: scraping shop visible`);
  }
});

// ── links byte-identical: all /go/ URLs are the same as the raw-name build ──────────────
test('links: /go/ URLs are slug-based and independent of the display spelling', async () => {
  const r = await call({ product: PRODUCT }, 'get_best_price', { ean: EAN1 }, CLAUDE);
  assert.deepEqual(goUrls(r.text).filter((u, i, a) => a.indexOf(u) === i), [
    `https://bikefuchs.com/go/bike-components/${EAN1}?src=mcp&loc=get_best_price`,
    `https://bikefuchs.com/go/fahrrad-teile-shop/${EAN1}?src=mcp&loc=get_best_price`,
    `https://bikefuchs.com/go/hibike/${EAN1}?src=mcp&loc=get_best_price`,
    `https://bikefuchs.com/go/rose-bikes/${EAN1}?src=mcp&loc=get_best_price`,
  ].map(u => u).sort());
});
