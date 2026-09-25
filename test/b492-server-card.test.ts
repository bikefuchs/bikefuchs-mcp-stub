/**
 * B-492 test — the /mcp server card is generated from the server's own tools/list and
 * initialize, and the hand-written /mcp/openai card is unchanged.
 *
 * The expected tools and capabilities come from the REAL /mcp request path, handle()
 * (flag OFF, i.e. the full server), not from the in-process helper the card itself
 * uses, so the card is checked against what clients actually receive.
 *
 *   [a] card.tools deep-equals the tools of a tools/list on /mcp
 *   [b] 7 tools; optimize_cart has "eans" and no "urls"; resolve_product is present
 *   [c] card.instructions starts with "Search with plain keywords via search_product"
 *   [d] card.capabilities deep-equals the capabilities of an initialize on /mcp
 *   [e] the B-477 tests still pass — `npm run test:b492` runs test/b477-parity.test.ts too
 *   [f] the /mcp/openai card is byte-identical to origin/main (fixture generated from
 *       origin/main's own app/lib/serverCard.ts at bd5e1f35)
 *
 * Run: npm run test:b492
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { handle } from '../app/lib/mcpServer';
import { GET as mcpCardGET } from '../app/.well-known/mcp/server-card.json/route';
import { GET as openaiCardGET } from '../app/.well-known/mcp/openai/server-card.json/route';

const FIXTURES = join(__dirname, 'fixtures', 'b492');
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

// Silences the [B365-DIAG] census line the full path prints.
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.info;
  console.info = () => {};
  try {
    const value = await fn();
    await new Promise((r) => setTimeout(r, 20)); // the census is fire-and-forget
    return value;
  } finally {
    console.info = original;
  }
}

async function mcpResult(message: object): Promise<Record<string, unknown>> {
  const saved = process.env.B477_EARLY_EXIT_ENABLED;
  delete process.env.B477_EARLY_EXIT_ENABLED; // full server path
  try {
    const res = await quiet(() =>
      handle(
        new Request('https://mcp.bikefuchs.com/mcp', {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }),
        }) as unknown as NextRequest,
        { feedOnly: false },
      ),
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { result: Record<string, unknown> };
    return json.result;
  } finally {
    if (saved === undefined) delete process.env.B477_EARLY_EXIT_ENABLED;
    else process.env.B477_EARLY_EXIT_ENABLED = saved;
  }
}

type Tool = { name: string; inputSchema: { properties?: Record<string, unknown> } };
type Card = { tools: Tool[]; instructions: string; capabilities: unknown; protocolVersion: string };

async function servedCard(): Promise<{ res: Response; card: Card }> {
  const res = await mcpCardGET();
  return { res, card: (await res.clone().json()) as Card };
}

test('[a] card.tools deep-equals the tools of a tools/list on /mcp', async () => {
  const { card } = await servedCard();
  const list = await mcpResult({ method: 'tools/list' });
  assert.deepEqual(card.tools, list.tools);
});

test('[b] 7 tools; optimize_cart has eans and no urls; resolve_product is present', async () => {
  const { card } = await servedCard();
  assert.equal(card.tools.length, 7);
  const optimize = card.tools.find((t) => t.name === 'optimize_cart');
  assert.ok(optimize, 'optimize_cart missing');
  const params = optimize.inputSchema.properties ?? {};
  assert.ok('eans' in params, 'optimize_cart has no "eans"');
  assert.ok(!('urls' in params), 'optimize_cart must not have "urls"');
  assert.ok(card.tools.some((t) => t.name === 'resolve_product'), 'resolve_product missing');
});

test('[c] card.instructions starts with the keyword-search sentence', async () => {
  const { card } = await servedCard();
  assert.ok(
    card.instructions.startsWith('Search with plain keywords via search_product'),
    `instructions start: ${card.instructions.slice(0, 60)}`,
  );
});

test('[d] card.capabilities deep-equals the capabilities of an initialize on /mcp', async () => {
  const { card } = await servedCard();
  const init = await mcpResult({
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'b492-test', version: '0' } },
  });
  assert.deepEqual(card.capabilities, init.capabilities);
  assert.equal(card.protocolVersion, init.protocolVersion);
});

test('[f] the /mcp/openai card is byte-identical to origin/main', async () => {
  const res = openaiCardGET();
  const body = Buffer.from(await res.arrayBuffer());
  const golden = readFileSync(join(FIXTURES, 'openai-server-card.origin-main.json'));
  assert.ok(body.equals(golden), `openai card differs from origin/main\n got: ${body}\nwant: ${golden}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
