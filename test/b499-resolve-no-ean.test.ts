/**
 * B-499 test — resolve_product must accept and render size options where ean is null
 * (Bike-Discount sizes with no barcode) on the CLAUDE profile (/mcp), while the OPENAI
 * profile (/mcp/openai) stays exactly as it behaves today (unvalidated null ean still
 * fails SDK output validation — this file proves that, it does not "fix" it).
 *
 *   [i]   claude: options with ean null + product_url validate (no SDK error) and the
 *         null-ean option renders the "kein Strichcode, direkter Link" line
 *   [ii]  claude: options with a normal string ean render BYTE-IDENTICALLY to today
 *   [iii] openai: tools/list outputSchema for resolve_product is byte-identical to
 *         origin/main (see test/b477-parity.test.ts's [f] fingerprint test for the
 *         whole-body proof; this file additionally drives a real tools/call with a
 *         null-ean option and confirms openai's behavior is UNCHANGED — still fails)
 *
 * Mocks global.fetch so /api/products/resolve never leaves the process.
 *
 * Run: node --import tsx --test test/b499-resolve-no-ean.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import { handle } from '../app/lib/mcpServer';

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.info;
  console.info = () => {};
  try {
    return await fn();
  } finally {
    console.info = original;
  }
}

function withMockedFetch<T>(responseBody: unknown, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(responseBody), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

type CallOpts = { feedOnly: boolean; renderProfile?: 'claude' | 'openai' };

async function callResolveProduct(
  url: string,
  opts: CallOpts,
): Promise<{ result?: { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }; error?: unknown }> {
  const res = await quiet(() =>
    handle(
      new Request(url, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'resolve_product', arguments: { url: 'https://www.bike-discount.de/de/fox-racing-baseframe-pro-d30-protektorweste', country: 'DE' } },
        }),
      }) as unknown as NextRequest,
      opts,
    ),
  );
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
  return JSON.parse(dataLine.replace(/^data: /, ''));
}

// One option WITH a barcode + product_url, one WITHOUT (Bike-Discount no-EAN size).
const MIXED_OPTIONS_RESOLVE_RESPONSE = {
  status: 'pick_variant',
  product_name: 'Fox Racing Baseframe Pro D30',
  shop: 'Bike-Discount',
  shop_id: 'bike-discount',
  axis: 'size',
  family_url: 'https://bikefuchs.com/go/url?shop=bike-discount&u=family&loc=pick_variant&src=mcp',
  min_price: 149.99,
  options: [
    {
      ean: '4067729043301',
      size: 'M',
      colour: null,
      price: 149.99,
      in_stock: true,
      product_url: 'https://bikefuchs.com/go/url?shop=bike-discount&u=m-variant&sku=100&loc=pick_variant&src=mcp',
    },
    {
      ean: null,
      size: 'L',
      colour: null,
      price: 149.99,
      in_stock: null,
      product_url: 'https://bikefuchs.com/go/url?shop=bike-discount&u=l-variant&sku=200&loc=pick_variant&src=mcp',
    },
  ],
};

// All options carry a normal string ean, no product_url at all — this is what every
// pre-B-499 pick_variant response looked like; must render byte-identically to today.
const ALL_EAN_RESOLVE_RESPONSE = {
  status: 'pick_variant',
  product_name: 'Some Rose Bikes Product',
  shop: 'Rose Bikes',
  shop_id: 'rosebikes',
  axis: 'size',
  family_url: 'https://bikefuchs.com/go/url?shop=rosebikes&u=family&loc=pick_variant&src=mcp',
  options: [
    { ean: '4006472000217', size: 'M', colour: null, price: 59.99, in_stock: true },
    { ean: '4006472000224', size: 'L', colour: null, price: 59.99, in_stock: false },
  ],
};

test('[i] claude (/mcp): a null-ean option validates (no SDK error) and renders the direct-link line', async () => {
  const json = await withMockedFetch(MIXED_OPTIONS_RESOLVE_RESPONSE, () =>
    callResolveProduct('https://mcp.bikefuchs.com/mcp', { feedOnly: false }),
  );

  assert.ok(!json.error, `unexpected JSON-RPC error: ${JSON.stringify(json.error)}`);
  assert.ok(json.result, 'no result in response');
  assert.ok(!json.result!.isError, `SDK returned an error result: ${JSON.stringify(json.result)}`);

  const text = json.result!.content[0].text;
  // The eaned option (M) keeps "— EAN: <ean>" and appends its own product_url link.
  assert.match(text, /— EAN: 4067729043301 — \[Größe M\]\(https:\/\/bikefuchs\.com\/go\/url\?shop=bike-discount&u=m-variant&sku=100&loc=pick_variant&src=mcp\)/);
  // The null-ean option (L) gets the direct-link line, never "— EAN: null".
  assert.match(text, /— kein Strichcode, direkter Link: \[Größe L\]\(https:\/\/bikefuchs\.com\/go\/url\?shop=bike-discount&u=l-variant&sku=200&loc=pick_variant&src=mcp\)/);
  assert.equal(text.includes('EAN: null'), false, 'must never render a fabricated "EAN: null"');

  // New directive sentence present (claude only).
  assert.match(text, /If the chosen variant has no EAN, do NOT call get_best_price\/optimize_cart/);

  // structuredContent carries product_url per option and top-level min_price.
  const options = json.result!.structuredContent!.options as Array<{ ean: string | null; product_url?: string }>;
  assert.equal(options[0].ean, '4067729043301');
  assert.equal(options[0].product_url, 'https://bikefuchs.com/go/url?shop=bike-discount&u=m-variant&sku=100&loc=pick_variant&src=mcp');
  assert.equal(options[1].ean, null);
  assert.equal(options[1].product_url, 'https://bikefuchs.com/go/url?shop=bike-discount&u=l-variant&sku=200&loc=pick_variant&src=mcp');
  assert.equal(json.result!.structuredContent!.min_price, 149.99);
});

test('[ii] claude (/mcp): options with a normal string ean render BYTE-IDENTICALLY to today (no product_url, no min_price)', async () => {
  const json = await withMockedFetch(ALL_EAN_RESOLVE_RESPONSE, () =>
    callResolveProduct('https://mcp.bikefuchs.com/mcp', { feedOnly: false }),
  );

  assert.ok(!json.error);
  assert.ok(!json.result!.isError);

  const text = json.result!.content[0].text;
  // Byte-identical to the pre-B-499 line shape: "N. label — price — stock — EAN: <ean>",
  // no appended link (product_url absent on these options).
  assert.match(text, /1\. Größe M — 59,99\s?€ — ✅ auf Lager — EAN: 4006472000217\n/);
  assert.match(text, /2\. Größe L — 59,99\s?€ — ❌ nicht auf Lager — EAN: 4006472000224/);
  assert.equal(text.includes('kein Strichcode'), false);
  assert.equal(text.includes(' — [Größe M](') && text.includes('4006472000217'), false, 'no link appended when product_url is absent');

  // min_price key IS present (declared optional, undefined when the API sends none) —
  // the SDK keeps declared-but-undefined keys out of structuredContent JSON entirely,
  // so it must simply be absent, not null or a stray key.
  assert.equal('min_price' in (json.result!.structuredContent ?? {}), false);
});

test('[iii] openai (/mcp/openai): a null-ean option still fails exactly as before (behavior UNCHANGED, not fixed here)', async () => {
  const json = await withMockedFetch(MIXED_OPTIONS_RESOLVE_RESPONSE, () =>
    callResolveProduct('https://mcp.bikefuchs.com/mcp/openai', { feedOnly: true, renderProfile: 'openai' }),
  );

  // The SDK's own output validation rejects a null where the openai schema still
  // requires z.string() — same failure mode the ticket describes, left untouched.
  const failed = Boolean(json.error) || Boolean(json.result?.isError);
  assert.ok(failed, `expected openai to still reject a null ean (schema untouched), got: ${JSON.stringify(json)}`);
});

test('[iii] openai (/mcp/openai): the ordinary all-string-ean case still renders byte-identically', async () => {
  const json = await withMockedFetch(ALL_EAN_RESOLVE_RESPONSE, () =>
    callResolveProduct('https://mcp.bikefuchs.com/mcp/openai', { feedOnly: true, renderProfile: 'openai' }),
  );

  assert.ok(!json.error, `unexpected JSON-RPC error: ${JSON.stringify(json.error)}`);
  assert.ok(!json.result!.isError, `SDK returned an error result: ${JSON.stringify(json.result)}`);
  const text = json.result!.content[0].text;
  assert.match(text, /1\. Größe M — 59,99\s?€ — ✅ auf Lager — EAN: 4006472000217/);
  assert.equal(json.result!.structuredContent!.disclosure !== undefined, true, 'openai-only fields still present');
});
