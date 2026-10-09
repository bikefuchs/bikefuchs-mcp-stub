/**
 * B-404 test — resolve_product turns the main app's failure `reason` into the right answer
 * (switch B404_STUB_REASONS_ENABLED). Drives the REAL handler through the SDK on both profiles
 * (so outputSchema validation is exercised); only global.fetch is mocked.
 *
 *   ON : unsupported_url / not_found / not_in_catalog → normal not_resolved + T1
 *        delisted → normal not_resolved + T3 (+ product_name)
 *        read_failed, non-2xx without reason, abort/network/non-JSON → isError + directive + T2
 *        bad_request / no_identifier → unchanged
 *   OFF: every one of those responses is exactly today's text
 *   tools/list fingerprints unchanged with the switch ON and OFF
 *
 * Run: node --import tsx --test test/b404-resolve-reasons.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { handle } from '../app/lib/mcpServer';

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const T1 = 'Diese URL konnte ich nicht auslesen. Nenn mir den genauen Produktnamen oder die EAN-Nummer.';
const T2 = 'Diese URL konnte ich gerade nicht auslesen. Nenn mir den genauen Produktnamen oder die EAN-Nummer.';
const T3 = 'Dieses Produkt bietet der Shop nicht mehr an. Nenn mir den genauen Produktnamen oder die EAN-Nummer, dann suche ich es in anderen Shops.';
const DIRECTIVE =
  'Tell the user the following sentence (translate only if the user writes in another language). Then, when the user gives a product name, call search_product; when they give an EAN, call get_best_price. Do not search the web for prices.';
const FOOTER_CLAUDE = '\n\n---\n*Powered by [Bikefuchs](https://bikefuchs.com)* 🦊 *· Preise & Verfügbarkeit ohne Gewähr · Kann Affiliate-Links enthalten*';
const FOOTER_OPENAI = '\n\n---\nPowered by Bikefuchs 🦊 · https://bikefuchs.com · Preise & Verfügbarkeit ohne Gewähr · Kann Affiliate-Links enthalten';

type Profile = 'claude' | 'openai';
const PROFILES: Array<{ name: Profile; url: string; opts: { feedOnly: boolean; renderProfile?: Profile }; footer: string }> = [
  { name: 'claude', url: 'https://mcp.bikefuchs.com/mcp', opts: { feedOnly: false }, footer: FOOTER_CLAUDE },
  { name: 'openai', url: 'https://mcp.bikefuchs.com/mcp/openai', opts: { feedOnly: true, renderProfile: 'openai' }, footer: FOOTER_OPENAI },
];

const ORIGINAL_SWITCH = process.env.B404_STUB_REASONS_ENABLED;
const ORIGINAL_FETCH = globalThis.fetch;
beforeEach(() => { delete process.env.B404_STUB_REASONS_ENABLED; });
afterEach(() => {
  if (ORIGINAL_SWITCH === undefined) delete process.env.B404_STUB_REASONS_ENABLED;
  else process.env.B404_STUB_REASONS_ENABLED = ORIGINAL_SWITCH;
  globalThis.fetch = ORIGINAL_FETCH;
});

type Mock =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'html'; status: number }
  | { kind: 'throw'; error: Error };

function mockFetch(m: Mock): void {
  globalThis.fetch = (async () => {
    if (m.kind === 'throw') throw m.error;
    if (m.kind === 'html') return new Response('<html>502</html>', { status: m.status, headers: { 'Content-Type': 'text/html' } });
    return new Response(JSON.stringify(m.body), { status: m.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

type ToolResult = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const i = console.info, e = console.error;
  console.info = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.info = i; console.error = e; }
}

async function rpc(p: (typeof PROFILES)[number], body: unknown): Promise<{ raw: Buffer; json: { result?: ToolResult; error?: unknown } }> {
  const res = await quiet(() =>
    handle(new Request(p.url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) }) as unknown as NextRequest, p.opts),
  );
  const raw = Buffer.from(await res.arrayBuffer());
  const text = raw.toString('utf8');
  const line = text.split('\n').find(l => l.startsWith('data: ')) ?? text;
  return { raw, json: JSON.parse(line.replace(/^data: /, '')) };
}

async function resolveCall(p: (typeof PROFILES)[number], m: Mock): Promise<ToolResult> {
  mockFetch(m);
  const { json } = await rpc(p, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'resolve_product', arguments: { url: 'https://www.bike24.de/p2462871.html', country: 'DE' } },
  });
  assert.ok(!json.error, `unexpected JSON-RPC error: ${JSON.stringify(json.error)}`);
  assert.ok(json.result, 'no result');
  return json.result!;
}

const body = (error: string, reason?: string, extra: Record<string, unknown> = {}) => ({ error, ...(reason ? { reason } : {}), ...extra });

// ── fixtures: [name, mock, ON expectation, today's (OFF) text builder] ──────────────
type Expect =
  | { kind: 'soft'; text: string; productName?: string }
  | { kind: 'error' }
  | { kind: 'unchanged' };

const FIXTURES: Array<{ name: string; mock: Mock; on: Expect; off: (footer: string) => string }> = [
  { name: 'unsupported_url (400)', mock: { kind: 'json', status: 400, body: body('This URL could not be read.', 'unsupported_url') }, on: { kind: 'soft', text: T1 },
    off: f => `Could not resolve product: This URL could not be read.${f}` },
  { name: 'not_found (502)', mock: { kind: 'json', status: 502, body: body('This shop page does not exist.', 'not_found') }, on: { kind: 'soft', text: T1 },
    off: f => `Could not resolve product: This shop page does not exist.${f}` },
  { name: 'not_in_catalog (404)', mock: { kind: 'json', status: 404, body: body('Product not found in feed database.', 'not_in_catalog') }, on: { kind: 'soft', text: T1 },
    off: f => `Could not resolve product: Product not found in feed database.${f}` },
  { name: 'delisted (404) with product_name', mock: { kind: 'json', status: 404, body: body('Gone.', 'delisted', { product_name: 'Shimano XT Kassette' }) }, on: { kind: 'soft', text: T3, productName: 'Shimano XT Kassette' },
    off: f => `Could not resolve product: Gone.${f}` },
  { name: 'delisted (404) without product_name', mock: { kind: 'json', status: 404, body: body('Gone.', 'delisted') }, on: { kind: 'soft', text: T3 },
    off: f => `Could not resolve product: Gone.${f}` },
  { name: 'read_failed (502)', mock: { kind: 'json', status: 502, body: body('Failed to fetch product data.', 'read_failed') }, on: { kind: 'error' },
    off: f => `Could not resolve product: Failed to fetch product data.${f}` },
  { name: 'non-2xx body without reason (504)', mock: { kind: 'json', status: 504, body: body('Timeout: BIKE24 did not respond within 12s. Try again later.') }, on: { kind: 'error' },
    off: f => `Could not resolve product: Timeout: BIKE24 did not respond within 12s. Try again later.${f}` },
  { name: 'unknown future reason (502)', mock: { kind: 'json', status: 502, body: body('Something new.', 'brand_new_reason') }, on: { kind: 'error' },
    off: f => `Could not resolve product: Something new.${f}` },
  { name: 'bad_request (400) unchanged', mock: { kind: 'json', status: 400, body: body('Invalid country. Use DE or AT.', 'bad_request') }, on: { kind: 'unchanged' },
    off: f => `Could not resolve product: Invalid country. Use DE or AT.${f}` },
  { name: 'no_identifier (404) unchanged', mock: { kind: 'json', status: 404, body: body('Could not extract a product identifier from this URL.', 'no_identifier') }, on: { kind: 'unchanged' },
    off: f => `Could not resolve product: Could not extract a product identifier from this URL.${f}` },
  { name: 'S3 network/abort throw', mock: { kind: 'throw', error: new Error('This operation was aborted') }, on: { kind: 'error' },
    off: f => `Request failed: This operation was aborted` },
  { name: 'S3 non-JSON response', mock: { kind: 'html', status: 502 }, on: { kind: 'error' },
    off: f => `Request failed: API returned unexpected content (text/html). The bikefuchs.com API may be temporarily unavailable.` },
];

for (const p of PROFILES) {
  for (const fx of FIXTURES) {
    test(`ON  · ${p.name} · ${fx.name}`, async () => {
      process.env.B404_STUB_REASONS_ENABLED = 'true';
      const r = await resolveCall(p, fx.mock);
      const text = r.content[0].text;

      if (fx.on.kind === 'soft') {
        assert.ok(!r.isError, `must be a NORMAL result, got isError`);
        assert.equal(text, `${DIRECTIVE}\n\n${fx.on.text}${p.footer}`);
        const sc = r.structuredContent!;
        assert.equal(sc.status, 'not_resolved');
        assert.equal(sc.resolved, false);
        assert.equal(sc.message, fx.on.text);
        assert.equal(sc.product_name, fx.on.productName ?? 'Das Produkt');
        assert.equal(typeof sc.shop, 'string');
        if (p.name === 'openai') {
          assert.equal(sc.tell_user, fx.on.text);
          assert.deepEqual(sc.next_step, { tool: 'search_product', hint: DIRECTIVE });
          assert.equal(sc.disclosure, p.footer);
        } else {
          assert.equal('tell_user' in sc, false, 'claude outputSchema has no tell_user — directive lives in content only');
          assert.equal('next_step' in sc, false);
        }
        assert.equal(/support/i.test(JSON.stringify(r)), false, 'output must never contain "support"');
      } else if (fx.on.kind === 'error') {
        assert.equal(r.isError, true);
        assert.equal(text, `${DIRECTIVE}\n\n${T2}${p.footer}`);
        assert.equal(r.structuredContent, undefined, 'no structuredContent on error results');
        assert.equal(/support/i.test(JSON.stringify(r)), false, 'output must never contain "support"');
      } else {
        assert.equal(r.isError, true);
        assert.equal(text, fx.off(p.footer), 'unchanged = today\'s text');
        assert.equal(r.structuredContent, undefined);
      }
    });

    test(`OFF · ${p.name} · ${fx.name} → today's exact text`, async () => {
      for (const v of [undefined, 'TRUE', '1', '']) {
        if (v === undefined) delete process.env.B404_STUB_REASONS_ENABLED; else process.env.B404_STUB_REASONS_ENABLED = v;
        const r = await resolveCall(p, fx.mock);
        assert.equal(r.isError, true, `switch=${JSON.stringify(v)}`);
        assert.equal(r.content[0].text, fx.off(p.footer), `switch=${JSON.stringify(v)}`);
        assert.equal(r.structuredContent, undefined);
      }
    });
  }
}

test('the three German user texts are verbatim (T1/T2/T3)', async () => {
  process.env.B404_STUB_REASONS_ENABLED = 'true';
  const p = PROFILES[0];
  assert.ok((await resolveCall(p, { kind: 'json', status: 400, body: body('x', 'unsupported_url') })).content[0].text.includes(T1));
  assert.ok((await resolveCall(p, { kind: 'json', status: 502, body: body('x', 'read_failed') })).content[0].text.includes(T2));
  assert.ok((await resolveCall(p, { kind: 'json', status: 404, body: body('x', 'delisted') })).content[0].text.includes(T3));
});

// ── tools/list must not move (switch ON and OFF) ───────────────────────────────
const FINGERPRINTS: Record<string, { bytes: number; sha256: string }> = {
  claude: { bytes: 14038, sha256: 'b7f5899cf8c5aa720065c399ff14d66d55bcdb0585d591d31b0706d16225b923' },
  openai: { bytes: 15865, sha256: 'a6de36069d83176ea7944a200250da6d19641edda5ec81f821702bcf345d2e32' },
};
for (const p of PROFILES) {
  for (const on of [false, true]) {
    test(`tools/list fingerprint unchanged · ${p.name} · switch ${on ? 'ON' : 'OFF'}`, async () => {
      if (on) process.env.B404_STUB_REASONS_ENABLED = 'true';
      const { raw } = await rpc(p, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(raw.length, FINGERPRINTS[p.name].bytes);
      assert.equal(createHash('sha256').update(raw).digest('hex'), FINGERPRINTS[p.name].sha256);
    });
  }
}
