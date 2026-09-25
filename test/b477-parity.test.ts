/**
 * B-477 parity test — the early exit for initialize / ping / notifications/initialized
 * must answer byte-identically to the full server path, for both channels.
 *
 * Drives the REAL exports from app/lib/mcpServer.ts: handle() (full path, flag OFF) and
 * b477EarlyExit() (flag ON). Expected bytes come from the full path itself and from the
 * production golden files in test/fixtures/b477/ — never from a copied string.
 *
 *   [a] flag ON:  early exit == full path (status, content-type, mcp-session-id, body bytes)
 *   [b] flag ON:  early exit == production golden file for cases a–e
 *   [c] flag ON:  every fall-through input returns null
 *   [d] flag OFF: returns null for every input, before touching the request at all
 *   [e] flag ON:  the B-365 POST census line still fires on the early path
 *   [f] tools/list fingerprints unchanged (hard rule for B-477)
 *
 * Run: npm run test:b477
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { b477EarlyExit, handle } from '../app/lib/mcpServer';

const FLAG = 'B477_EARLY_EXIT_ENABLED';
const FIXTURES = join(__dirname, 'fixtures', 'b477');

type Opts = { feedOnly: boolean; renderProfile?: 'claude' | 'openai' };
const CHANNELS: { name: string; url: string; fixture: string; opts: Opts }[] = [
  { name: '/mcp', url: 'https://mcp.bikefuchs.com/mcp', fixture: 'mcp', opts: { feedOnly: false } },
  {
    name: '/mcp/openai',
    url: 'https://mcp.bikefuchs.com/mcp/openai',
    fixture: 'mcp_openai',
    opts: { feedOnly: true, renderProfile: 'openai' },
  },
];

const BASE_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
type Case = { body: unknown; headers?: Record<string, string> };

const initialize = (protocolVersion: string, id: unknown = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'b477-probe', version: '0' } },
});
const PING = { jsonrpc: '2.0', id: 2, method: 'ping' };
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

// Cases a–e: the production golden files exist for these (file stem = key).
const GOLDEN_CASES: Record<string, Case> = {
  a_init_20250618: { body: initialize('2025-06-18') },
  b_init_20250326: { body: initialize('2025-03-26') },
  c_init_20241105: { body: initialize('2024-11-05') },
  d_initialized: { body: INITIALIZED },
  e_ping: { body: PING },
};
const EXTRA_CASES: Record<string, Case> = {
  init_unknown_version: { body: initialize('1999-01-01') },
  init_string_id: { body: initialize('2025-06-18', 'abc') },
  ping_supported_protocol_header: { body: PING, headers: { 'mcp-protocol-version': '2025-06-18' } },
};
const FALL_THROUGH_CASES: Record<string, Case> = {
  batch_initialize: { body: [initialize('2025-06-18')] },
  batch_ping: { body: [PING] },
  initialize_without_params: { body: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
  ping_with_meta: { body: { ...PING, params: { _meta: { progressToken: 1 } } } },
  initialize_with_meta: {
    body: { ...initialize('2025-06-18'), params: { ...initialize('2025-06-18').params, _meta: { progressToken: 1 } } },
  },
  bad_accept: { body: PING, headers: { Accept: 'application/json' } },
  bad_content_type: { body: PING, headers: { 'Content-Type': 'text/plain' } },
  unsupported_protocol_header_ping: { body: PING, headers: { 'mcp-protocol-version': '1999-01-01' } },
  unsupported_protocol_header_initialized: { body: INITIALIZED, headers: { 'mcp-protocol-version': '1999-01-01' } },
  invalid_json: { body: '{nope' },
  tools_list: { body: { jsonrpc: '2.0', id: 9, method: 'tools/list' } },
  server_discover: { body: { jsonrpc: '2.0', id: 3, method: 'server/discover' } },
};

function makeRequest(url: string, c: Case, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { ...BASE_HEADERS, ...c.headers },
    body: method === 'GET' ? undefined : typeof c.body === 'string' ? c.body : JSON.stringify(c.body),
  });
}

type Snapshot = { status: number; contentType: string | null; sessionId: string | null; body: Buffer };
async function snapshot(res: Response): Promise<Snapshot> {
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    sessionId: res.headers.get('mcp-session-id'),
    body: Buffer.from(await res.arrayBuffer()),
  };
}

// Env and console are process-global; node:test runs top-level tests in one file in series.
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

// Silences the [B365-DIAG] census lines both paths print, and records them for [e].
async function captureInfo<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const original = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    const value = await fn();
    await new Promise((r) => setTimeout(r, 20)); // the census is fire-and-forget
    return { value, lines };
  } finally {
    console.info = original;
  }
}

const fullPath = (ch: (typeof CHANNELS)[number], c: Case) =>
  withFlag(undefined, async () => snapshot(await handle(makeRequest(ch.url, c) as unknown as NextRequest, ch.opts)));

async function earlyExit(ch: (typeof CHANNELS)[number], c: Case): Promise<Snapshot | null> {
  return withFlag('true', async () => {
    const res = await b477EarlyExit(makeRequest(ch.url, c), ch.opts);
    return res ? snapshot(res) : null;
  });
}

function assertSame(actual: Snapshot, expected: Snapshot, label: string): void {
  assert.equal(actual.status, expected.status, `${label}: status`);
  assert.equal(actual.contentType, expected.contentType, `${label}: content-type`);
  assert.equal(actual.sessionId, expected.sessionId, `${label}: mcp-session-id`);
  assert.ok(actual.body.equals(expected.body), `${label}: body bytes differ\n got: ${actual.body}\nwant: ${expected.body}`);
}

function readGolden(fixture: string, name: string): Snapshot {
  const stem = join(FIXTURES, `${fixture}__${name}`);
  const headerLines = readFileSync(`${stem}.headers.txt`, 'utf8').split(/\r?\n/);
  const header = (key: string) => {
    const line = headerLines.find((l) => l.toLowerCase().startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : null;
  };
  return {
    status: Number(headerLines[0].split(' ')[1]),
    contentType: header('content-type'),
    sessionId: header('mcp-session-id'),
    body: readFileSync(`${stem}.body.txt`),
  };
}

for (const ch of CHANNELS) {
  test(`[a] ${ch.name}: flag ON early exit == full path`, async () => {
    await captureInfo(async () => {
      for (const [name, c] of Object.entries({ ...GOLDEN_CASES, ...EXTRA_CASES })) {
        const early = await earlyExit(ch, c);
        assert.ok(early, `${name}: early exit returned null`);
        assertSame(early, await fullPath(ch, c), `${ch.name} ${name}`);
      }
    });
  });

  test(`[b] ${ch.name}: flag ON early exit == production golden file`, async () => {
    await captureInfo(async () => {
      for (const [name, c] of Object.entries(GOLDEN_CASES)) {
        // Guard against the fixture and the test case drifting apart.
        const goldenRequest = JSON.parse(readFileSync(join(FIXTURES, `${ch.fixture}__${name}.request.json`), 'utf8'));
        assert.deepEqual(goldenRequest, c.body, `${name}: request fixture differs from the test case`);
        const early = await earlyExit(ch, c);
        assert.ok(early, `${name}: early exit returned null`);
        assertSame(early, readGolden(ch.fixture, name), `${ch.name} ${name} vs production`);
      }
    });
  });

  test(`[c] ${ch.name}: flag ON fall-through inputs return null`, async () => {
    await captureInfo(async () => {
      for (const [name, c] of Object.entries(FALL_THROUGH_CASES)) {
        assert.equal(await earlyExit(ch, c), null, `${name}: early exit must fall through`);
      }
      const get = await withFlag('true', () => b477EarlyExit(makeRequest(ch.url, { body: null }, 'GET'), ch.opts));
      assert.equal(get, null, 'GET must fall through');
    });
  });

  test(`[d] ${ch.name}: flag OFF returns null for every input, before any work`, async () => {
    const all = { ...GOLDEN_CASES, ...EXTRA_CASES, ...FALL_THROUGH_CASES };
    for (const flag of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes']) {
      await withFlag(flag, async () => {
        for (const [name, c] of Object.entries(all)) {
          assert.equal(await b477EarlyExit(makeRequest(ch.url, c), ch.opts), null, `flag=${JSON.stringify(flag)} ${name}`);
        }
        // "Before any work": a request whose every property access throws must still
        // produce null, so not even the method, headers or body are read.
        const untouchable = new Proxy({} as Request, {
          get(_t, prop) {
            throw new Error(`flag OFF touched request.${String(prop)}`);
          },
        });
        assert.equal(await b477EarlyExit(untouchable, ch.opts), null, `flag=${JSON.stringify(flag)} untouchable`);
      });
    }
  });

  test(`[e] ${ch.name}: flag ON early path keeps the B-365 POST census line`, async () => {
    for (const [name, c, method] of [
      ['initialize', GOLDEN_CASES.a_init_20250618, 'initialize'],
      ['ping', GOLDEN_CASES.e_ping, 'ping'],
      ['initialized', GOLDEN_CASES.d_initialized, 'notifications/initialized'],
    ] as const) {
      const { value, lines } = await captureInfo(() => earlyExit(ch, c));
      assert.ok(value, `${name}: early exit returned null`);
      const diag = lines.filter((l) => l.startsWith('[B365-DIAG]'));
      assert.equal(diag.length, 1, `${name}: expected exactly one census line, got ${JSON.stringify(lines)}`);
      assert.ok(diag[0].includes(`path=${new URL(ch.url).pathname} method=POST`), `${name}: ${diag[0]}`);
      assert.ok(diag[0].endsWith(`jsonrpc_method=${method}`), `${name}: ${diag[0]}`);
    }
  });
}

// Hard rule: the tools/list output must not change. Hashes are the sha256 of the full
// tools/list response body (id 1) at production commit 993321c4.
const TOOLS_LIST_ID1: Case = { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } };
const TOOLS_LIST_FINGERPRINTS: Record<string, { bytes: number; sha256: string }> = {
  '/mcp': { bytes: 13792, sha256: 'a757f24351d83d7645bcc433ea9d6500ab6ffa4a7e8db905735bbb2dbc647ce2' },
  '/mcp/openai': { bytes: 15865, sha256: 'a6de36069d83176ea7944a200250da6d19641edda5ec81f821702bcf345d2e32' },
};

for (const ch of CHANNELS) {
  for (const flag of [undefined, 'true']) {
    test(`[f] ${ch.name}: tools/list fingerprint unchanged (flag ${flag ? 'ON' : 'OFF'})`, async () => {
      const { value } = await captureInfo(() =>
        withFlag(flag, async () =>
          snapshot(await handle(makeRequest(ch.url, TOOLS_LIST_ID1) as unknown as NextRequest, ch.opts)),
        ),
      );
      const want = TOOLS_LIST_FINGERPRINTS[ch.name];
      assert.equal(value.body.length, want.bytes, 'tools/list bytes');
      assert.equal(createHash('sha256').update(value.body).digest('hex'), want.sha256, 'tools/list sha256');
    });
  }
}
