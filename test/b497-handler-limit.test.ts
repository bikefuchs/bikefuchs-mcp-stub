/**
 * B-497 Step 2 — handler-side rate-limit gate tests (middleware.ts removed).
 *
 * Flag semantics flipped for this step: the gate now runs UNLESS
 * B497_LIMIT_IN_HANDLER === 'false' — a missing env var must never mean "no rate
 * limit" once middleware.ts is gone. 'false' is kept only as an emergency off
 * switch. See app/lib/mcpServer.ts's `limitInHandler` for the single source of
 * this semantic.
 *
 * Covers:
 *   [a] flag unset (new default: gate ON) vs flag 'false' (emergency off) →
 *       handle() output for the B-477 golden cases and tools/list is
 *       byte-identical either way to the existing production goldens / fixed
 *       sha256 fingerprints (test/fixtures/b477/, and the same constants
 *       test/b477-parity.test.ts asserts against) — no KV_* env in this process,
 *       so checkLimits fails open (allowed) whenever the gate does run — AND the
 *       gate's own `[B497] hl ...` log line appears exactly when expected: once
 *       per request when unset, never when 'false'.
 *   [b] handlerLimitGate(): the B-364 method gate, AI-egress skip, and B-366 probe
 *       skip/shadow mirror middleware.ts's former behaviour exactly (same order,
 *       same log lines, same {response,source} contract) — exercised against the
 *       real, unmocked function. Unaffected by the B497_LIMIT_IN_HANDLER flip:
 *       these tests call handlerLimitGate() directly, and that function never
 *       reads B497_LIMIT_IN_HANDLER itself — only handle() does, to decide
 *       whether to call it at all.
 *   [c] a forged x-bf-rl-source header on the inbound request never overrides the
 *       resolved source — it is always clientIp(req.headers).
 *   [d] flag unset (default ON) + initialize (answered by b477EarlyExit) never
 *       calls handlerLimitGate at all — proven by the absence of its
 *       `[B497] hl ...` log line, the only externally observable trace it
 *       leaves; contrasted with tools/list (not handled by the early exit),
 *       which does reach it.
 *   [e] middleware.ts must not exist at the repo root — this suite's entire
 *       premise (the handler gate is now the ONLY gate) breaks silently if
 *       someone resurrects it.
 *
 * The "limited" (checkLimits returning ok:false) response shape is covered
 * separately in test/b497-limited-response.test.ts, which needs KV_REST_API_URL /
 * KV_REST_API_TOKEN set for the whole process before rateLimit.ts's module-scope
 * Redis/Ratelimit singletons are constructed — see that file's header for why it
 * can't share a process with these tests.
 *
 * Run: npm run test:b497
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { handle } from '../app/lib/mcpServer';
import { handlerLimitGate } from '../app/lib/handlerLimit';

// ── [e] middleware.ts must stay gone ────────────────────────────────────────────
test('[e] middleware.ts does not exist at the repo root', () => {
  const path = join(__dirname, '..', 'middleware.ts');
  assert.equal(existsSync(path), false, `${path} must not exist — the handler gate is now the only gate`);
});

const FLAG = 'B497_LIMIT_IN_HANDLER';
const B477_FLAG = 'B477_EARLY_EXIT_ENABLED';
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

function makeRequest(
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  method = 'POST',
): Request {
  return new Request(url, {
    method,
    headers: { ...BASE_HEADERS, ...extraHeaders },
    body: method === 'GET' ? undefined : JSON.stringify(body),
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

// Env and console are process-global; node:test runs top-level tests in one file in series.
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function captureInfo<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const original = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    const value = await fn();
    await new Promise((r) => setTimeout(r, 20)); // fire-and-forget diagnostics (B-365) settle
    return { value, lines };
  } finally {
    console.info = original;
  }
}

const initialize = (protocolVersion: string, id: unknown = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'b497-probe', version: '0' } },
});
const PING = { jsonrpc: '2.0', id: 2, method: 'ping' };
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const GOLDEN_CASES: Record<string, unknown> = {
  a_init_20250618: initialize('2025-06-18'),
  b_init_20250326: initialize('2025-03-26'),
  c_init_20241105: initialize('2024-11-05'),
  d_initialized: INITIALIZED,
  e_ping: PING,
};
const TOOLS_LIST_ID1 = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
// Same constants test/b477-parity.test.ts asserts against — production commit 993321c4.
const TOOLS_LIST_FINGERPRINTS: Record<string, { bytes: number; sha256: string }> = {
  '/mcp': { bytes: 13792, sha256: 'a757f24351d83d7645bcc433ea9d6500ab6ffa4a7e8db905735bbb2dbc647ce2' },
  '/mcp/openai': { bytes: 15865, sha256: 'a6de36069d83176ea7944a200250da6d19641edda5ec81f821702bcf345d2e32' },
};

// ── [a] byte parity either way, AND the gate runs/doesn't run as expected ─────────
// B477_EARLY_EXIT_ENABLED is left unset throughout this section, so b477EarlyExit
// never answers here — every GOLDEN_CASES / tools/list request in this loop falls
// through to (and, when the gate is on, reaches) handlerLimitGate.
for (const ch of CHANNELS) {
  for (const flag of [undefined, 'false']) {
    const gateShouldRun = flag !== 'false';

    test(`[a] ${ch.name}: B497_LIMIT_IN_HANDLER=${JSON.stringify(flag)} → initialize/ping/initialized unchanged, gate ${gateShouldRun ? 'runs' : "doesn't run"}`, async () => {
      await withEnv({ [FLAG]: flag }, async () => {
        const { lines } = await captureInfo(async () => {
          for (const [name, body] of Object.entries(GOLDEN_CASES)) {
            const res = await handle(makeRequest(ch.url, body) as unknown as NextRequest, ch.opts);
            assertSame(await snapshot(res), readGolden(ch.fixture, name), `${ch.name} ${name} (B497=${flag})`);
          }
        });
        const hlLines = lines.filter((l) => l.startsWith('[B497] hl'));
        assert.equal(
          hlLines.length,
          gateShouldRun ? Object.keys(GOLDEN_CASES).length : 0,
          `${ch.name} B497=${flag}: expected ${gateShouldRun ? 'one hl line per request' : 'no hl lines'}, got ${JSON.stringify(hlLines)}`,
        );
      });
    });

    test(`[a] ${ch.name}: B497_LIMIT_IN_HANDLER=${JSON.stringify(flag)} → tools/list fingerprint unchanged, gate ${gateShouldRun ? 'runs' : "doesn't run"}`, async () => {
      await withEnv({ [FLAG]: flag }, async () => {
        const { value: res, lines } = await captureInfo(() =>
          handle(makeRequest(ch.url, TOOLS_LIST_ID1) as unknown as NextRequest, ch.opts),
        );
        const body = Buffer.from(await res.arrayBuffer());
        const want = TOOLS_LIST_FINGERPRINTS[ch.name];
        assert.equal(body.length, want.bytes, `tools/list bytes (B497=${flag})`);
        assert.equal(createHash('sha256').update(body).digest('hex'), want.sha256, `tools/list sha256 (B497=${flag})`);
        const hlLines = lines.filter((l) => l.startsWith('[B497] hl'));
        assert.equal(
          hlLines.length,
          gateShouldRun ? 1 : 0,
          `${ch.name} B497=${flag}: expected ${gateShouldRun ? 'exactly one hl line' : 'no hl line'}, got ${JSON.stringify(hlLines)}`,
        );
      });
    });
  }
}

// ── [b] handlerLimitGate mirrors middleware.ts's gate ordering exactly ─────────────
test('[b] skip-method: B-364 gate skips GET when its flag is on, before a source is resolved', async () => {
  const { value, lines } = await captureInfo(() =>
    withEnv({ B364_METHOD_GATE_ENABLED: 'true' }, () =>
      handlerLimitGate(makeRequest('https://mcp.bikefuchs.com/mcp', null, {}, 'GET') as unknown as NextRequest),
    ),
  );
  assert.equal(value.response, null);
  assert.equal(value.source, null);
  assert.deepEqual(
    lines.filter((l) => l.startsWith('[B497]')),
    ['[B497] hl result=skip-method method=GET'],
  );
});

test('[b] skip-method: B-364 gate is a no-op when its flag is unset (POST still checked normally)', async () => {
  const { value, lines } = await captureInfo(() =>
    withEnv({ B364_METHOD_GATE_ENABLED: undefined }, () =>
      handlerLimitGate(
        makeRequest('https://mcp.bikefuchs.com/mcp', PING, { 'x-vercel-forwarded-for': '203.0.113.10' }) as unknown as NextRequest,
      ),
    ),
  );
  assert.equal(value.response, null);
  assert.equal(value.source, '203.0.113.10');
  assert.deepEqual(
    lines.filter((l) => l.startsWith('[B497]')),
    ['[B497] hl result=allowed method=POST'],
  );
});

test('[b] skip-ai: an Anthropic-egress IP skips both limits — no key, no recording', async () => {
  const { value, lines } = await captureInfo(() =>
    handlerLimitGate(
      makeRequest('https://mcp.bikefuchs.com/mcp', PING, { 'x-vercel-forwarded-for': '160.79.104.5' }) as unknown as NextRequest,
    ),
  );
  assert.equal(value.response, null);
  assert.equal(value.source, null);
  assert.deepEqual(
    lines.filter((l) => l.startsWith('[B497]')),
    ['[B497] hl result=skip-ai method=POST'],
  );
});

test('[b] probe-skip: a known probe IP with B-366 flag on is skipped — no key, no recording', async () => {
  const { value, lines } = await captureInfo(() =>
    withEnv({ B366_PROBE_ALLOWLIST_ENABLED: 'true' }, () =>
      handlerLimitGate(
        makeRequest('https://mcp.bikefuchs.com/mcp', PING, { 'x-vercel-forwarded-for': '15.204.10.2' }) as unknown as NextRequest,
      ),
    ),
  );
  assert.equal(value.response, null);
  assert.equal(value.source, null);
  assert.deepEqual(
    lines.filter((l) => l.startsWith('[B497]')),
    ['[B497] hl result=probe-skip method=POST'],
  );
  const mwLines = lines.filter((l) => l.startsWith('[MW]'));
  assert.equal(mwLines.length, 1, JSON.stringify(lines));
  assert.ok(mwLines[0].includes('flag=on applied=skipped') && mwLines[0].includes('B366_SKIP_APPLIED'), mwLines[0]);
});

test('[b] probe-shadow: a known probe IP with B-366 flag off/unset still reaches checkLimits (shadow-logged)', async () => {
  const { value, lines } = await captureInfo(() =>
    withEnv({ B366_PROBE_ALLOWLIST_ENABLED: undefined }, () =>
      handlerLimitGate(
        makeRequest('https://mcp.bikefuchs.com/mcp', PING, { 'x-vercel-forwarded-for': '15.204.10.2' }) as unknown as NextRequest,
      ),
    ),
  );
  // KV_* is unset in this process → checkLimits fails open → allowed. The point of this
  // test is the SHADOW log line + that the source survives, not the fail-open per se.
  assert.equal(value.response, null);
  assert.equal(value.source, '15.204.10.2');
  assert.deepEqual(
    lines.filter((l) => l.startsWith('[B497]')),
    ['[B497] hl result=allowed method=POST'],
  );
  const mwLines = lines.filter((l) => l.startsWith('[MW]'));
  assert.equal(mwLines.length, 1, JSON.stringify(lines));
  assert.ok(mwLines[0].includes('flag=off applied=limited') && mwLines[0].includes('B366_SKIP_SHADOW'), mwLines[0]);
});

// ── [c] a forged RL_SOURCE_HEADER never overrides clientIp() ───────────────────────
test('[c] a forged x-bf-rl-source header is ignored; source is always clientIp(req.headers)', async () => {
  const { value } = await captureInfo(() =>
    handlerLimitGate(
      makeRequest('https://mcp.bikefuchs.com/mcp', PING, {
        'x-vercel-forwarded-for': '203.0.113.20',
        'x-bf-rl-source': '9.9.9.9',
      }) as unknown as NextRequest,
    ),
  );
  assert.equal(value.response, null);
  assert.equal(value.source, '203.0.113.20');
  assert.notEqual(value.source, '9.9.9.9');
  // handle()'s recordCoverage branch (app/lib/mcpServer.ts) reads exactly this
  // returned `source` into its local `hlSource` when B497_LIMIT_IN_HANDLER is on, and
  // never re-reads req.headers.get(RL_SOURCE_HEADER) in that mode — see
  // "RECORDCOVERAGE SOURCE HANDLING" in the B-497 Step 1 report for the file:line.
  // recordCoverage itself is not intercepted here: it is a real @upstash/redis call
  // with no dependency-injection seam, and KV_* is unset in this process, so it is
  // already a guaranteed no-op regardless of which source it would receive — there is
  // nothing further this process could observe even with a mock. See DEVIATIONS.
});

// ── [d] the gate never runs once b477EarlyExit already answered ────────────────────
test('[d] flag unset (default ON) + initialize is answered by b477EarlyExit; handlerLimitGate never runs', async () => {
  await withEnv({ [FLAG]: undefined, [B477_FLAG]: 'true' }, async () => {
    const { value, lines } = await captureInfo(() =>
      handle(makeRequest('https://mcp.bikefuchs.com/mcp', initialize('2025-06-18')) as unknown as NextRequest, {
        feedOnly: false,
      }),
    );
    assert.equal(value.status, 200);
    assert.equal(lines.filter((l) => l.startsWith('[B477] early')).length, 1, JSON.stringify(lines));
    assert.deepEqual(
      lines.filter((l) => l.startsWith('[B497] hl')),
      [],
      'handlerLimitGate must not run once b477EarlyExit already answered',
    );
  });
});

test('[d] flag unset (default ON) + tools/list (not answered by b477EarlyExit) does reach handlerLimitGate', async () => {
  await withEnv({ [FLAG]: undefined, [B477_FLAG]: 'true' }, async () => {
    const { lines } = await captureInfo(() =>
      handle(makeRequest('https://mcp.bikefuchs.com/mcp', TOOLS_LIST_ID1) as unknown as NextRequest, { feedOnly: false }),
    );
    assert.deepEqual(lines.filter((l) => l.startsWith('[B477] early')), []);
    assert.equal(lines.filter((l) => l.startsWith('[B497] hl')).length, 1, JSON.stringify(lines));
  });
});
