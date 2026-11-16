/**
 * B-538 — price guarantee in optimize_cart / get_best_price (both profiles).
 *
 * The API fixtures in test/fixtures/b538/ are REAL responses of the main app's optimize-from-eans route (display mode,
 * guaranteeDisplay:true) for Korb D / Korb E / a box-only cart, produced offline by the main app's parity harness
 * (feature/b538-mcp-guarantee). Korb E's per-offer prices are a SYNTHETIC reconstruction tuned to the live log figures
 * (optimum 143,78 €, Maciag joker 140,79 €). The golden files in golden-f2787be5/ are the output of the UNCHANGED stub at
 * f2787be5 for the same no-guarantee API responses ⇒ "byte-identical without a guarantee" is proven against the old code.
 *
 * Run: node --import tsx --test test/b538-guarantee-display.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { handle } from '../app/lib/mcpServer';

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
type Sc = Record<string, any>;
type Opts = { feedOnly: boolean; renderProfile?: 'claude' | 'openai' };
const PROFILES: Array<{ name: 'claude' | 'openai'; opts: Opts }> = [
  { name: 'claude', opts: { feedOnly: false } },
  { name: 'openai', opts: { feedOnly: true, renderProfile: 'openai' } },
];
const fx = (f: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/b538', f), 'utf8'));
const E = ['7630554949567', '9010583262215', '4717784043098', '0196261014440'];
const D = ['4055184043202', '5056286974486'];
const L = ['5056286919180', '4524667879565', '4550170172053'];

async function call(tool: string, args: Record<string, unknown>, api: unknown, opts: Opts) {
  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  const origInfo = console.info;
  console.info = () => {};
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' ? input : (input as Request).url ?? String(input));
    seen.push(u.pathname + u.search + (init?.body ? ' ' + String(init.body) : ''));
    return new Response(JSON.stringify(api), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const res = await handle(
      new Request('http://b538.test/mcp', { method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) }) as unknown as NextRequest,
      opts,
    );
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data: ')) ?? text;
    const out = JSON.parse(line.replace(/^data: /, '')).result as { content: Array<{ text: string }>; structuredContent?: Sc; isError?: boolean };
    return { text: out.content[0]!.text, sc: (out.structuredContent ?? null) as Sc | null, isError: out.isError ?? false, seen };
  } finally { globalThis.fetch = origFetch; console.info = origInfo; }
}
const optimize = (eans: string[], api: unknown, p: typeof PROFILES[number]) => call('optimize_cart', { eans }, api, p.opts);
const bestPrice = (api: unknown, p: typeof PROFILES[number]) => call('get_best_price', { ean: D[0] }, api, p.opts);
const NOTE_RE = /^The Maciag Offroad lines marked 'per Bestpreisgarantie anfragen' are price-guarantee requests, not guaranteed prices: the shop reviews each request itself\. Show the competitor link for each such line and give the 'ohne Anpassung' total next to the adjusted total\.$/;
const NOTE = "The Maciag Offroad lines marked 'per Bestpreisgarantie anfragen' are price-guarantee requests, not guaranteed prices: the shop reviews each request itself. Show the competitor link for each such line and give the 'ohne Anpassung' total next to the adjusted total.";

// ── no guarantee ⇒ byte-identical to the unchanged stub (golden files made by f2787be5) ──────────────────────────────
for (const p of PROFILES) {
  test(`[off] ${p.name}: optimize_cart without a guarantee ≡ f2787be5 output (text + structuredContent)`, async () => {
    const g = fx(`golden-f2787be5/optimize_cart.${p.name}.json`);
    const r = await optimize(E, fx('api-optimize-korbE_plain.json'), p);
    assert.equal(r.isError, false);
    assert.equal(r.text, g.text);
    assert.deepEqual(r.sc, g.sc);
  });
  test(`[off] ${p.name}: guaranteeApplied:null (evaluated, joker did not win) ≡ f2787be5 output`, async () => {
    const g = fx(`golden-f2787be5/optimize_cart.${p.name}.json`);
    const r = await optimize(E, { ...fx('api-optimize-korbE_plain.json'), guaranteeApplied: null }, p);
    assert.equal(r.text, g.text);
    assert.deepEqual(r.sc, g.sc);
  });
  test(`[off] ${p.name}: get_best_price without price_guarantee rows ≡ f2787be5 output`, async () => {
    const g = fx(`golden-f2787be5/get_best_price.${p.name}.json`);
    const r = await bestPrice(fx('api-product-plain.json'), p);
    assert.equal(r.text, g.text);
    assert.deepEqual(r.sc, g.sc);
  });
}

// ── requests ──────────────────────────────────────────────────────────────────────────────────────────────────────────
for (const p of PROFILES) {
  test(`[req] ${p.name}: optimize_cart sends guaranteeDisplay:true (feedOnly only on openai); get_best_price sends guarantee=1`, async () => {
    const o = await optimize(E, fx('api-optimize-korbE_plain.json'), p);
    const body = JSON.parse(o.seen[0]!.split(' ').slice(1).join(' '));
    assert.equal(body.guaranteeDisplay, true);
    assert.equal(body.feedOnly === true, p.name === 'openai');
    const b = await bestPrice(fx('api-product-plain.json'), p);
    assert.match(b.seen[0]!, /^\/api\/products\/4055184043202\?country=DE(&feedOnly=true)?&guarantee=1$/);
  });
}

// ── Korb E: joker applied ─────────────────────────────────────────────────────────────────────────────────────────────
for (const p of PROFILES) {
  test(`[E] ${p.name}: joker group printed with the API's texts; order line adds up; competitor links src=mcp; footnote; note`, async () => {
    const r = await optimize(E, fx(p.name === 'openai' ? 'api-optimize-korbE_openai.json' : 'api-optimize-korbE.json'), p);
    assert.equal(r.isError, false, 'structuredContent must validate against the declared outputSchema');
    const t = r.text.replace(/\u00a0/g, ' '); // formatEuro uses a no-break space before €
    assert.ok(t.includes('Am günstigsten: alles bei Maciag Offroad per Bestpreisgarantie – in 1 Paket.'));
    assert.ok(t.includes('**Maciag Offroad** — Artikel 137,84 € + Versand 0,00 € + Versandausgleich Bestpreisgarantie 2,95 € = 140,79 €'), 'Artikel 137,84 + Versand 0 + Versandausgleich 2,95 = 140,79');
    for (const s of [
      'per Bestpreisgarantie anfragen · günstiger bei ROSE Bikes: 19,95 € + 2,95 € Versand (für alle 3 ROSE Bikes-Artikel)',
      'per Bestpreisgarantie anfragen · günstiger bei ROSE Bikes: 34,95 €',
      'per Bestpreisgarantie anfragen · günstiger bei ROSE Bikes: 24,95 €',
      'So geht’s: Auf der Produktseite bei Maciag „Bestpreisgarantie“ wählen und den Link zum günstigeren Angebot eintragen – vor dem Kauf oder bis 5 Tage danach.',
      '* Erwarteter Maximalpreis, wenn Maciag Offroad deine Bestpreisanfrage annimmt. Der Shop prüft jede Anfrage selbst; ohne Anpassung kostet die Bestellung 164,34 €.',
      '**Total cost: 140,79 €**',
    ]) assert.ok(t.includes(s), s);
    for (const e of E.slice(0, 3)) assert.ok(t.includes(`https://bikefuchs.com/go/rose-bikes/${e}?src=mcp&loc=guarantee_competitor`), `competitor link for ${e}`);
    assert.ok(!t.includes('src=website') && !t.includes('competitorGoUrl'));
    assert.equal((t.match(/guarantee_competitor/g) ?? []).length, 3, 'exactly one competitor link per claimed line (the own-price line D has none)');
    assert.ok(t.includes(NOTE), 'model note in content');
    if (p.name === 'claude') {
      assert.ok(t.includes(`[per Bestpreisgarantie anfragen · günstiger bei ROSE Bikes: 34,95 €](https://bikefuchs.com/go/rose-bikes/9010583262215?src=mcp&loc=guarantee_competitor)`), 'markdown link on claude');
    } else {
      assert.ok(t.includes('günstiger bei ROSE Bikes: 34,95 €\n       https://bikefuchs.com/go/rose-bikes/9010583262215?src=mcp&loc=guarantee_competitor'), 'bare URL on its own line on openai');
    }
  });
  test(`[E] ${p.name}: structuredContent.guarantee (+ note: guarantee_note on claude, tell_user on openai)`, async () => {
    const r = await optimize(E, fx(p.name === 'openai' ? 'api-optimize-korbE_openai.json' : 'api-optimize-korbE.json'), p);
    const g = r.sc!.guarantee;
    assert.deepEqual({ shop: g.shop, reason: g.reason, total: g.total, unadjusted_total: g.unadjusted_total, shipping_adjustment: g.shipping_adjustment }, { shop: 'Maciag Offroad', reason: 'cheaper', total: 140.79, unadjusted_total: 143.78, shipping_adjustment: 2.95 });
    assert.deepEqual(g.lines.map((l: Sc) => [l.ean, l.own_price, l.matched_price, l.competitor_shop, l.competitor_price, l.competitor_shipping_shown]), [
      [E[0], 29.45, 19.95, 'ROSE Bikes', 19.95, 2.95],
      [E[1], 44.95, 34.95, 'ROSE Bikes', 34.95, null],
      [E[2], 31.95, 24.95, 'ROSE Bikes', 24.95, null],
    ]);
    assert.deepEqual(g.lines.map((l: Sc) => l.competitor_url), E.slice(0, 3).map(e => `https://bikefuchs.com/go/rose-bikes/${e}?src=mcp&loc=guarantee_competitor`));
    if (p.name === 'claude') {
      assert.equal(r.sc!.guarantee_note, NOTE);
      assert.ok(!('tell_user' in r.sc!), 'the claude profile has no tell_user');
    } else {
      assert.ok(!('guarantee_note' in r.sc!), 'openai carries the note inside tell_user, no new field');
      assert.ok((r.sc!.tell_user as string).endsWith(NOTE) && (r.sc!.tell_user as string).startsWith('Show the per-shop split'));
    }
  });
}

// ── Korb D (REAL offers) ───────────────────────────────────────────────────────────────────────────────────────────────
test('[D] claude: Bike-Discount + bike-components references, links built from slug + ean', async () => {
  const r = await optimize(D, fx('api-optimize-korbD.json'), PROFILES[0]!);
  assert.equal(r.isError, false);
  assert.ok(r.text.includes('https://bikefuchs.com/go/bike-discount/4055184043202?src=mcp&loc=guarantee_competitor'));
  assert.ok(r.text.includes('https://bikefuchs.com/go/bike-components/5056286974486?src=mcp&loc=guarantee_competitor'));
  assert.ok(r.text.includes('günstiger bei Bike-Discount: 14,99 € + 4,49 € Versand') && r.text.includes('günstiger bei bike-components: 42,99 € + 4,99 € Versand'));
  assert.ok(r.text.replace(/\u00a0/g, ' ').includes('Artikel 57,98 € + Versand 4,95 € + Versandausgleich Bestpreisgarantie 4,53 € = 67,46 €'), 'the CEO cart: 57,98 + 4,95 + 4,53 = 67,46');
  assert.equal(r.sc!.guarantee.reason, 'fewer_non_affiliate_packages');
});

// ── box only ───────────────────────────────────────────────────────────────────────────────────────────────────────────
for (const p of PROFILES) {
  test(`[box] ${p.name}: only singleShopOption.guarantee ⇒ API box text + claim lines + adjustment + footnote as an extra paragraph; no cart guarantee`, async () => {
    const r = await optimize(L, fx('api-optimize-boxL.json'), p);
    assert.equal(r.isError, false);
    const t = r.text;
    assert.ok(t.includes('💡 Lieber alles aus einem Shop? Alles bei Maciag Offroad für 180,85 €* mit Bestpreisgarantie'), 'box text from the API');
    assert.ok(t.includes('per Bestpreisgarantie anfragen · günstiger bei fahrrad-teile.shop: 90,00 € + 5,90 € Versand'));
    assert.ok(t.includes('per Bestpreisgarantie anfragen · günstiger bei BOC24: 20,00 € + 4,95 € Versand'));
    assert.ok(t.includes('Versandausgleich Bestpreisgarantie +10,85 €'));
    assert.ok(t.includes('* Erwarteter Maximalpreis, wenn Maciag Offroad deine Bestpreisanfrage annimmt.'));
    assert.ok(t.includes('https://bikefuchs.com/go/fahrrad-teile-shop/4524667879565?src=mcp&loc=guarantee_competitor'));
    assert.ok(!t.includes('Am günstigsten:'), 'no recommendation sentence: the joker did not replace the optimum');
    assert.ok(!('guarantee' in r.sc!), 'structuredContent.guarantee is only for an applied guarantee');
    assert.ok(t.includes(NOTE));
    if (p.name === 'claude') assert.equal(r.sc!.guarantee_note, NOTE); else assert.ok((r.sc!.tell_user as string).endsWith(NOTE));
  });
}

// ── get_best_price marker ─────────────────────────────────────────────────────────────────────────────────────────────
for (const p of PROFILES) {
  test(`[gbp] ${p.name}: " · ✓ Bestpreisgarantie" only on price_guarantee === true rows; structuredContent prices[].price_guarantee`, async () => {
    const r = await bestPrice(fx('api-product-marked.json'), p);
    assert.equal(r.isError, false);
    const rows = r.text.split('\n').filter(l => /^\d+\. /.test(l));
    const byShop = (s: string) => rows.find(l => l.includes(`— ${s}`));
    assert.ok(byShop('Maciag Offroad')!.endsWith(' · ✓ Bestpreisgarantie'));
    assert.ok(!byShop('ROSE Bikes')!.includes('Bestpreisgarantie'), 'absent ⇒ no marker');
    if (p.name === 'claude') {
      assert.ok(byShop('Bike-Discount')!.endsWith(' · ✓ Bestpreisgarantie'));
      assert.ok(!byShop('BIKE24')!.includes('Bestpreisgarantie'), 'false ⇒ no marker');
    } else {
      assert.equal(byShop('Bike-Discount'), undefined, 'feed-only profile never lists Bike-Discount / BIKE24 (existing filter) — only Maciag can carry the marker');
      assert.equal(byShop('BIKE24'), undefined);
    }
    const flags = Object.fromEntries((r.sc!.prices as Sc[]).map(x => [x.shop, x.price_guarantee]));
    assert.deepEqual(flags, p.name === 'claude'
      ? { 'ROSE Bikes': undefined, 'Bike-Discount': true, 'BIKE24': undefined, 'Maciag Offroad': true }
      : { 'ROSE Bikes': undefined, 'Maciag Offroad': true });
  });
}

// ── schema / version / tool count / B-133 ─────────────────────────────────────────────────────────────────────────────
async function toolsList(opts: Opts) {
  const res = await handle(new Request('http://b538.test/mcp', { method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }) as unknown as NextRequest, opts);
  const text = await res.text();
  return (JSON.parse((text.split('\n').find(l => l.startsWith('data: ')) ?? text).replace(/^data: /, '')).result.tools) as Array<{ name: string; outputSchema: { properties: Sc } }>;
}
for (const p of PROFILES) {
  test(`[schema] ${p.name}: 7 tools; new fields are OPTIONAL in the profile that emits them`, async () => {
    const tools = await toolsList(p.opts);
    assert.equal(tools.length, 7);
    const oc = tools.find(t => t.name === 'optimize_cart')!.outputSchema as Sc;
    assert.ok(oc.properties.guarantee && !oc.required.includes('guarantee'));
    assert.deepEqual(oc.properties.guarantee.properties.shipping, { type: 'number' });
    assert.ok(!oc.properties.guarantee.required.includes('shipping'), 'shipping is optional');
    assert.equal('guarantee_note' in oc.properties, p.name === 'claude');
    if (p.name === 'claude') assert.ok(!oc.required.includes('guarantee_note'));
    const gbp = tools.find(t => t.name === 'get_best_price')!.outputSchema as Sc;
    assert.deepEqual(gbp.properties.prices.items.properties.price_guarantee, { type: 'boolean' });
    assert.ok(!gbp.properties.prices.items.required.includes('price_guarantee'));
  });
}
// ── Phase 1b: total line shows shipping and Versandausgleich separately ────────────────────────────────────────────────
const NB = /\u00a0/g;
const totalLine = (t: string) => t.replace(NB, ' ').split('\n').find(l => l.startsWith('**Total cost:'))!;
for (const p of PROFILES) {
  test(`[1b] ${p.name}: Korb E / Korb D / negative adjustment — separate amounts, shipping + adjustment = totalShipping`, async () => {
    const cases: Array<[string, string[], string, number, number]> = [
      [p.name === 'openai' ? 'api-optimize-korbE_openai.json' : 'api-optimize-korbE.json', E, '(incl. 0,00 € shipping · Versandausgleich Bestpreisgarantie +2,95 €)', 0, 2.95],
      ['api-optimize-korbD.json', D, '(incl. 4,95 € shipping · Versandausgleich Bestpreisgarantie +4,53 €)', 4.95, 4.53],
      ['api-optimize-korbE_negadj.json', E, '(incl. 0,00 € shipping · Versandausgleich Bestpreisgarantie \u22121,50 €)', 0, -1.5],
    ];
    for (const [f, eans, want, ship, adj] of cases) {
      const api = fx(f);
      const r = await optimize(eans, api, p);
      assert.equal(r.isError, false, f);
      assert.ok(totalLine(r.text).includes(want), `${f}: ${totalLine(r.text)}`);
      assert.ok(!totalLine(r.text).includes('incl. ' + (Math.round(api.result.totalShipping * 100) / 100).toFixed(2).replace('.', ',') + ' € shipping)'), 'no combined figure');
      assert.equal(r.sc!.guarantee.shipping, ship);
      assert.equal(r.sc!.guarantee.shipping_adjustment, adj);
      assert.equal(Math.round((r.sc!.guarantee.shipping + r.sc!.guarantee.shipping_adjustment) * 100), Math.round(api.result.totalShipping * 100), 'shipping + adjustment = totalShipping to the cent');
    }
  });
  test(`[1b] ${p.name}: adjustment 0 / no guarantee ⇒ old combined wording`, async () => {
    const api = fx('api-optimize-korbE.json');
    api.guaranteeApplied.shippingAdjustment = 0;
    const r = await optimize(E, api, p);
    assert.ok(totalLine(r.text).includes(`(incl. 2,95 € shipping)`), totalLine(r.text));
  });
}

test('[version] serverInfo and server.json say 2.6.0', async () => {
  const { SERVER_INFO } = await import('../app/lib/mcpServer');
  assert.equal(SERVER_INFO.version, '2.6.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '../server.json'), 'utf8')).version, '2.6.0');
});
test('[B-133] no output (content or structuredContent, any fixture, any profile) mentions how prices are obtained', async () => {
  const bad = /scrap|badge|page.?pars|cache|crawl/i;
  for (const p of PROFILES) {
    for (const [f, eans] of [['api-optimize-korbE.json', E], ['api-optimize-korbD.json', D], ['api-optimize-boxL.json', L]] as const) {
      const r = await optimize(eans, fx(f), p);
      assert.ok(!bad.test(r.text) && !bad.test(JSON.stringify(r.sc)), `${p.name} ${f}`);
    }
    const g = await bestPrice(fx('api-product-marked.json'), p);
    assert.ok(!bad.test(g.text) && !bad.test(JSON.stringify(g.sc)));
  }
});
test('[note] the model note is exactly the specified sentence with the actual shop name', () => {
  assert.match(NOTE, NOTE_RE);
});
