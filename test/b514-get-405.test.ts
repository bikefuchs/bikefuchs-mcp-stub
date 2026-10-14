/**
 * B-514 — GET /mcp and /mcp/openai answered with 405 instead of a bounded SSE stream.
 *
 * Covers:
 *   [a] flag unset / 'false' / 'TRUE' / '1' (anything but exactly 'true'): a GET asking
 *       for text/event-stream behaves as before — 200 text/event-stream, and the
 *       B-365 [B365-DIAG] line, no [B514] line.
 *   [b] flag 'true': the same GET → 405, `Allow: POST, OPTIONS`, empty body, no
 *       content-type, well under 1 s; the [B365-DIAG] line is byte-identical to the
 *       flag-OFF one; exactly one `[B514] get405 path=<path>` line.
 *   [c] flag 'true': a GET WITHOUT text/event-stream is untouched (the transport's 406).
 *   [d] flag 'true': POST initialize and tools/list answer byte-for-byte what they
 *       answer with the flag off (status, content-type, body bytes), on both channels,
 *       and print no [B514] line.
 *
 * Run: npm run test:b514
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import { handle } from '../app/lib/mcpServer';

const FLAG = 'B514_GET_405_ENABLED';

type Opts = { feedOnly: boolean; renderProfile?: 'claude' | 'openai' };
const CHANNELS: { name: string; path: string; opts: Opts }[] = [
  { name: '/mcp', path: '/mcp', opts: { feedOnly: false } },
  { name: '/mcp/openai', path: '/mcp/openai', opts: { feedOnly: true, renderProfile: 'openai' } },
];

const GET_HEADERS = {
  Accept: 'text/event-stream',
  'user-agent': 'node',
  'x-vercel-forwarded-for': '34.153.188.190',
};

function toNextRequest(req: Request): NextRequest {
  // handle() reads req.nextUrl.pathname; a plain Request has none.
  return Object.assign(req, { nextUrl: new URL(req.url) }) as unknown as NextRequest;
}
const getReq = (path: string, headers: Record<string, string> = GET_HEADERS) =>
  toNextRequest(new Request(`https://mcp.bikefuchs.com${path}`, { method: 'GET', headers }));
const postReq = (path: string, body: unknown) =>
  toNextRequest(
    new Request(`https://mcp.bikefuchs.com${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    }),
  );

async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  }
}

async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

async function captureInfo<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const original = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    return { value: await fn(), lines };
  } finally {
    console.info = original;
  }
}

// OFF-path GET opens a real SSE stream. With the B-497 gate on, handle() then awaits
// res.clone().json() for coverage recording, i.e. until the 15 s B-365 close — so the
// OFF-path GET tests run with B497_LIMIT_IN_HANDLER=false (no `source`, returns at
// once). The 15 s close timer still holds the process open; `after` exits it.
async function offGet(path: string, opts: Opts, flag: string | undefined) {
  const { value: res, lines } = await captureInfo(() =>
    withEnv('B497_LIMIT_IN_HANDLER', 'false', () => withFlag(flag, () => handle(getReq(path), opts))),
  );
  await res.body?.cancel();
  return { res, lines };
}

for (const ch of CHANNELS) {
  for (const flag of [undefined, 'false', 'TRUE', '1', ' true']) {
    test(`[a] ${ch.name}: flag ${JSON.stringify(flag)} → GET SSE unchanged (200 event-stream)`, async () => {
      const { res, lines } = await offGet(ch.path, ch.opts, flag);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      assert.equal(lines.filter((l) => l.startsWith('[B365-DIAG]')).length, 1);
      assert.equal(lines.filter((l) => l.startsWith('[B514]')).length, 0);
    });
  }

  test(`[b] ${ch.name}: flag 'true' → 405 + Allow, empty body, < 1 s, identical DIAG line`, async () => {
    const off = await offGet(ch.path, ch.opts, undefined);
    const t0 = performance.now();
    const { value: res, lines } = await captureInfo(() => withFlag('true', () => handle(getReq(ch.path), ch.opts)));
    const ms = performance.now() - t0;

    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST, OPTIONS');
    assert.equal(res.headers.get('content-type'), null);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);

    const diagOn = lines.filter((l) => l.startsWith('[B365-DIAG]'));
    const diagOff = off.lines.filter((l) => l.startsWith('[B365-DIAG]'));
    assert.deepEqual(diagOn, diagOff, 'B365-DIAG GET line must be identical ON vs OFF');
    assert.deepEqual(lines.filter((l) => l.startsWith('[B514]')), [`[B514] get405 path=${ch.path}`]);
  });

  test(`[c] ${ch.name}: flag 'true' → GET without text/event-stream untouched (406)`, async () => {
    const { value: res, lines } = await captureInfo(() =>
      withFlag('true', () => handle(getReq(ch.path, { Accept: 'application/json' }), ch.opts)),
    );
    assert.equal(res.status, 406);
    assert.equal(lines.filter((l) => l.startsWith('[B514]')).length, 0);
  });

  const POSTS: [string, unknown][] = [
    ['initialize', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'b514', version: '0' } } }],
    ['tools/list', { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
  ];
  for (const [name, body] of POSTS) {
    test(`[d] ${ch.name}: POST ${name} byte-identical flag ON vs OFF`, async () => {
      const run = async (flag: string | undefined) => {
        const { value: res, lines } = await captureInfo(() => withFlag(flag, () => handle(postReq(ch.path, body), ch.opts)));
        return { status: res.status, ct: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()), lines };
      };
      const off = await run(undefined);
      const on = await run('true');
      assert.equal(on.status, 200);
      assert.equal(on.status, off.status);
      assert.equal(on.ct, off.ct);
      assert.ok(on.body.equals(off.body), `${name}: body bytes differ`);
      assert.equal(on.lines.filter((l) => l.startsWith('[B514]')).length, 0);
    });
  }
}

// The flag-OFF GET tests leave 15 s SSE-close timers behind.
after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));
