# B-345 — MCP Discovery 406 Investigation (read-only findings)

**Date:** 2026-08-22
**Investigator branch:** `b345-discovery-investigation` (worktree `bikefuchs-mcp-stub-worktrees/b345-discovery`) off `origin/main` @ `938c625`.
**Status:** discovery only. No application file changed, nothing deployed, nothing merged.

Throughout: **MEASURED** = I observed it directly this session. **INFERRED** = reasoned from evidence, not proven. **UNDETERMINED** = I could not establish it.

---

## 1. Which repo and files serve mcp.bikefuchs.com

**Repo:** `bikefuchs/bikefuchs-mcp-stub` (public). Deploys to Vercel project `bikefuchs-mcp-stub` (`prj_ZpiE2otOT9Fjfi72xnADhV32dAcw`) → `mcp.bikefuchs.com`. **NOT** the main app repo.

- **Canonical local checkout:** `/Users/mattchuk/Bikefuchs/Claude/bikefuchs-mcp-stub` (it owns the `bikefuchs-mcp-stub-worktrees/` parent; two other standalone clones exist — `bikefuchs-mcp-stub-readonly`, `bikefuchs-mcp-stub-b259` — at older SHAs). MEASURED via `git worktree list`.
- **Stack:** Next.js `^15.3.0` App Router; `@modelcontextprotocol/sdk ^1.11.0`; server manifest `server.json` version `2.5.0`. MEASURED (`package.json`, `server.json`).

**Files that decide the outcome:**

| File | Role |
|------|------|
| `app/[...transport]/route.ts` | Catch-all route. `GET`/`POST`/`DELETE` → `handle(req, {feedOnly:false})`. Matches **every** path with no more-specific route. |
| `app/lib/mcpServer.ts` (`handle()`, lines 1483–1510) | Creates `WebStandardStreamableHTTPServerTransport` and calls `transport.handleRequest(req)`. **No path branching.** |
| `middleware.ts` | Rate-limit gate. `matcher: ['/mcp', '/mcp/openai']` only. Does **not** touch `/.well-known/*` or `/robots.txt`. |
| `app/.well-known/mcp/server-card.json/route.ts` | Specific route → 200 JSON server card. |
| `app/.well-known/mcp/openai/server-card.json/route.ts` | Specific route → 200 JSON. |
| `next.config.js` | `headers()` rule for `/.well-known/openai-apps-challenge` (text/plain). No rewrites/redirects. |
| `public/.well-known/openai-apps-challenge` | The only static file under `public/`. **No `robots.txt` exists.** |

---

## 2. Reproduction table (live, mcp.bikefuchs.com, 2026-08-22)

### 2a. Path × method (default `curl`, no explicit Accept) — MEASURED

| Path | Method | Status | `x-matched-path` | `content-type` |
|------|--------|--------|------------------|----------------|
| `/robots.txt` | GET | **406** | `/[...transport]` | application/json |
| `/.well-known/mcp` | GET | **406** | `/[...transport]` | application/json |
| `/.well-known/mcp.json` | GET | **406** | `/[...transport]` | application/json |
| `/.well-known/agent.json` | GET | **406** | `/[...transport]` | application/json |
| `/.well-known/oauth-authorization-server` | GET | **406** | `/[...transport]` | application/json |
| `/.well-known/oauth-protected-resource` | GET | **406** | `/[...transport]` | application/json |
| `/mcp` | GET | **406** | `/[...transport]` | application/json |
| `/mcp/.well-known/oauth-authorization-server` | GET | **406** | `/[...transport]` | application/json |
| `/mcp/.well-known/oauth-protected-resource` | GET | **406** | `/[...transport]` | application/json |
| `/mcp/.well-known/mcp` | GET | **406** | `/[...transport]` | application/json |
| `/.well-known/mcp/server-card.json` | GET | **200** | (own route) | application/json |
| `/.well-known/mcp/openai/server-card.json` | GET | **200** | (own route) | application/json |
| `/.well-known/openai-apps-challenge` | GET | **200** | `/.well-known/openai-apps-challenge` | text/plain |

**406 response body (identical for all):**
```json
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept text/event-stream"},"id":null}
```

> ⚠️ **The prompt's central contrast does NOT reproduce today.** The 200s logged on 2026-07-31 / 2026-08-22 for `/mcp/.well-known/*` are **406 right now**, identical to their root twins. See §4.

### 2b. `/robots.txt` × Accept header (isolating the trigger) — MEASURED

| Accept header | Status |
|---------------|--------|
| *(none)* | 406 |
| `*/*` | 406 |
| `text/plain` | 406 |
| `application/json` | 406 |
| `text/event-stream` | **no 406** — connection held open, no status line within 4s (SSE-style long hold) |
| `application/json, text/event-stream` | **no 406** — same hold |

**Trigger identified (MEASURED):** the 406 fires **iff the `Accept` header does not contain the literal `text/event-stream` media-type token.** A wildcard `*/*` does **not** satisfy it (the SDK does an exact-token check, not content-negotiation matching). Method and path are **not** the trigger — a GET on `/robots.txt` with `text/event-stream` stops 406ing. Path only matters insofar as it determines whether a *more specific route* intercepts before the catch-all.

---

## 3. Exact code location and mechanism (quoted)

The 406 is **not** produced by our own code and **not** by middleware. It is produced inside the MCP SDK's Streamable-HTTP transport, reached through our catch-all route.

**Chain:**

`app/[...transport]/route.ts` — matches every otherwise-unrouted path:
```ts
import { handle } from "../lib/mcpServer";
export function GET(req: NextRequest) { return handle(req, { feedOnly: false }); }
export function POST(req: NextRequest) { return handle(req, { feedOnly: false }); }
export function DELETE(req: NextRequest) { return handle(req, { feedOnly: false }); }
```

`app/lib/mcpServer.ts` `handle()` (1487–1493) — unconditionally hands the request to the transport, **no path inspection**:
```ts
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
const server = createServer({ feedOnly, renderProfile });
await server.connect(transport);
const res = await transport.handleRequest(req);
```

`transport.handleRequest(req)` (in `@modelcontextprotocol/sdk`, `server/webStandardStreamableHttp.js`) enforces the MCP Streamable-HTTP requirement that clients accept `text/event-stream`, and returns the `-32000 "Not Acceptable"` JSON-RPC error with HTTP 406 when they don't.

- MEASURED: the error string, status, and body come back live; `x-matched-path: /[...transport]` proves the catch-all matched.
- **UNDETERMINED (source-level):** I could not open the SDK source line — **no `node_modules` is installed in any local clone**, so I could not grep the exact file/line inside `@modelcontextprotocol/sdk`. The origin is nonetheless pinned to `handleRequest` by the response body + the code path above.

`middleware.ts` is **excluded** as the cause (MEASURED): its matcher is `['/mcp', '/mcp/openai']`, so `/robots.txt` and `/.well-known/*` never enter it. The prompt's working hypothesis ("middleware accepting only POST with a specific Accept/Content-Type") is therefore **refuted** — the middleware neither runs on these paths nor checks Accept.

---

## 4. Why specific paths 200 and everything else 406 — and the subpath question

**The real routing model (MEASURED + code-confirmed):**

Next.js App Router resolves the **most specific** match first. Three things win before the catch-all:
1. Explicit route files: `/.well-known/mcp/server-card.json`, `/.well-known/mcp/openai/server-card.json` → **200**.
2. Static files in `public/`: `/.well-known/openai-apps-challenge` → **200**.
3. Everything else → the `app/[...transport]` catch-all → `handle()` → 406 (unless Accept has `text/event-stream`).

So the dividing line is **"does a specific route/static file exist for this exact path?"** — not root-vs-subpath.

**On the reported `/mcp/.well-known/* → 200` vs `/.well-known/* → 406` contrast:**

- In the current code, **neither** `/mcp/.well-known/oauth-authorization-server` **nor** `/.well-known/oauth-authorization-server` has a specific route. Both fall to the same catch-all. MEASURED: **both are 406 today**, byte-identical. The path prefix `/mcp/` changes nothing in routing.
- **There has never been an OAuth handler in this repo.** MEASURED: `grep -rniE "oauth|protected-resource|authorization-server"` over `app/`, `public/`, `server.json` = no matches; `git log --all -S "oauth"` = no commits. So the logged 200s were **not** served by any OAuth/discovery code we ever shipped.

Because the current code cannot produce that contrast, the logged 200s must have another origin. Candidate explanations, **all INFERRED and none proven**:

- **(A) Different `Accept` header from those specific crawlers.** A GET carrying `Accept: text/event-stream` does **not** 406 (MEASURED — it's held open as a stream). If the crawlers that hit the `/mcp/.well-known/*` variants happened to send `text/event-stream` while the ones hitting root paths sent `application/json`/`*/*`, the access log would show 200 vs 406 with **no routing difference at all**. This fits the evidence best but I could not confirm the crawlers' request headers.
- **(B) A since-changed deployment.** The 200s are dated up to 2026-08-22, but I cannot map those log lines to the exact deployment/commit then live.

**UNDETERMINED:** which of (A)/(B) is correct. I attempted the Vercel runtime logs to read the crawlers' actual `Accept` headers and per-path status history, but the **Vercel MCP token is expired** ("requires re-authorization") and I may not re-auth (user action). I did **not** try to guess. Note also: even the SSE "200" is not a *useful* discovery response — it's an open event stream, not a metadata document — so option (A), if true, means the crawlers still failed to index us; it was never a real success.

---

## 5. Spec findings (with sources) and compliance verdict

**Protocol version:** server uses the `@modelcontextprotocol/sdk ^1.11.0` default; `server.json`'s `2.5.0` is the *registry manifest* version and its `$schema` is the registry schema `2025-12-11`, **not** the MCP protocol revision. I reference the **2025-06-18** authorization spec below (current published revision; the SDK 1.11.x line targets this era). *(Version-exactness of the protocol revision is INFERRED, not pinned to a constant in our code — `mcpServer.ts` sets no explicit `protocolVersion`.)*

**MCP Authorization (2025-06-18), source: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization**
- Authorization is **OPTIONAL**. "Authorization is OPTIONAL for MCP implementations." A server with no auth is spec-legal.
- *If* auth is supported: servers **MUST** implement RFC 9728 Protected Resource Metadata, **MUST** return `authorization_servers`, and **MUST** send `WWW-Authenticate` on 401. The discovery flow starts with an **unauthenticated MCP request → 401 + `WWW-Authenticate`**, from which the client derives the resource-metadata URL — clients are not required to blind-guess `/.well-known/*`.
- **OAuth metadata location:** governed by **RFC 9728** (protected-resource) and **RFC 8414** (authorization-server). These are **well-known URIs at the host root** (RFC 8615), path-aware: for a resource at `https://host/mcp`, RFC 9728 derives `https://host/.well-known/oauth-protected-resource/mcp` — i.e. `.well-known` **at the root with the resource path appended**, *not* `/mcp/.well-known/...`. So our current *working-subpath* layout (`/mcp/.well-known/...`), even when it was returning 200, was **not** the RFC-defined location anyway. *(RFC path-construction detail is from the spec's RFC references; I did not re-read RFC 9728 §3 line-by-line this session — INFERRED from the cited RFCs.)*

**`/.well-known/mcp`, `/.well-known/mcp.json`, `/.well-known/agent.json`:** **not defined** anywhere in the 2025-06-18 MCP spec text fetched. These are conventions used by third-party agent directories/registries (the crawlers named in the ticket), not MCP-mandated endpoints. Our real card lives at `/.well-known/mcp/server-card.json` (a registry/Smithery-style convention), which those crawlers do not request. *(That these paths are crawler conventions rather than a spec requirement is INFERRED from their absence in the spec + the crawler UAs in the ticket.)*

**`/robots.txt`:** not an MCP concern at all; a plain static file that simply doesn't exist here.

**Verdict:**
- OAuth discovery: the server implements **no** OAuth, which is **spec-compliant** (auth is OPTIONAL). The problem is the **wrong error shape** — an absent OAuth resource should be **404**, but the catch-all makes it **406**. That can mislead a crawler into thinking auth exists but is misconfigured. Call this **compliant-but-misleading**.
- MCP core transport at `/mcp` (POST, `Accept: application/json, text/event-stream`): **compliant and working** — the 406 on a bare `GET /mcp` is exactly what the Streamable-HTTP spec prescribes for a client that doesn't accept `text/event-stream`.
- Registry/agent-directory discovery (`/.well-known/mcp`, `agent.json`, `robots.txt`): **non-compliant with those crawlers' expectations** — they get 406 instead of either a document (200) or an honest 404.

---

## 6. Fix options (analysis only — no code written)

For each: what it changes · risk · how to verify. **None of these should touch the `/mcp` POST transport**, which is live and must not regress.

**Option 1 — Narrow the catch-all so non-MCP paths don't reach the transport.**
Today `app/[...transport]` swallows literally every path. Constrain what reaches `handle()` (e.g. only serve the transport for the intended endpoint(s) and let unmatched paths 404 naturally).
- *Changes:* unmatched paths return 404 instead of 406.
- *Risk:* **MEDIUM–HIGH.** The transport is *currently mounted via the catch-all itself* — `mcp.bikefuchs.com/mcp` is served by `app/[...transport]`, not by an `app/mcp/route.ts` (there is none; only `app/mcp/openai/route.ts` exists). Removing/narrowing the catch-all without first giving `/mcp` its own explicit route **would break the live endpoint.** Must be done as "add explicit `/mcp` route, then narrow catch-all," verified together.
- *Verify:* POST `/mcp` initialize still 200s; `GET /robots.txt` → 404; directory crawlers re-index.

**Option 2 — Serve discovery documents at root (in addition to the subpath).**
Add explicit routes/static files for the paths crawlers actually request: `/.well-known/mcp`, `/.well-known/mcp.json`, `/.well-known/agent.json`, and (if/when auth is added) RFC-correct `/.well-known/oauth-protected-resource[/mcp]`.
- *Changes:* those exact paths return 200 documents; they bypass the catch-all as specific routes (proven by the existing `server-card.json` 200s).
- *Risk:* **LOW.** Additive; specific routes win over the catch-all; `/mcp` transport untouched. Main risk is publishing an OAuth metadata doc that claims auth we don't enforce — so only add OAuth docs if we actually implement auth.
- *Verify:* each new path returns the expected JSON with 200; `/mcp` POST unchanged.

**Option 3 — Add a static `robots.txt`.**
Drop `public/robots.txt` (or an `app/robots.ts`). Being a static/specific asset, it bypasses the catch-all.
- *Changes:* `/robots.txt` → 200 text.
- *Risk:* **LOW.** Purely additive. Content choice (allow/deny) is a policy decision, not a technical risk.
- *Verify:* `curl /robots.txt` → 200 `text/plain`; `/mcp` untouched.

**Option 4 — Return 404 instead of 406 for genuinely-absent resources.**
Either via Option 1 (let Next.js 404 unmatched paths) or by making `handle()` pre-check the path and 404 non-transport requests before invoking the SDK.
- *Changes:* honest 404 for `/robots.txt`, `/.well-known/oauth-*` (while unauthenticated), etc.
- *Risk:* **MEDIUM** if done inside `handle()` (adds path logic to the hot transport path — must not misclassify a real `/mcp` transport call as absent). **LOW–MEDIUM** if done via routing (same caveat as Option 1 about mounting `/mcp` explicitly first).
- *Verify:* absent paths → 404; `/mcp` POST initialize → 200; SSE GET with correct Accept still streams.

**Recommended combination (analysis, not a decision):** Options 2 + 3 are low-risk and directly unblock the crawlers (the growth goal) without touching the transport. Option 1/4 (fixing 406→404) is the "correct" cleanup but carries the mounting risk above and should be a separate, carefully-verified change. **Any option that removes or narrows `app/[...transport]` MUST first give `/mcp` its own explicit route, or the live endpoint breaks** — this is the single biggest regression risk.

---

## 7. What I could NOT determine

1. **Exact SDK source line** for the 406 — no `node_modules` installed in any local clone; the origin is pinned to `transport.handleRequest` by behavior + code path, but not read at the source line.
2. **Why the logs showed `/mcp/.well-known/* → 200`** on 2026-07-31/08-22 — the current code + live tests show 406 for those paths. Candidate causes (different crawler `Accept` header producing an SSE 200; or a different deployment then live) are INFERRED and unproven. The Vercel MCP token is **expired**, so I could not read the crawlers' request headers or per-path status history to settle it. This is the single most important open item — the whole ticket premise rests on a contrast I could not reproduce.
3. **Exact MCP protocol revision** the server negotiates — no explicit `protocolVersion` constant in our code; taken as the SDK 1.11.x default (2025-06-18 era), INFERRED.
4. **RFC 9728/8414 path-construction specifics** are summarized from the MCP spec's references; I did not line-read those RFCs this session.
5. **Whether adding root discovery docs would actually make the named crawlers index us** — depends on each crawler's exact expected schema at each path; not verified against their specs.

---

*End of read-only findings. No implementation performed. Awaiting approval before any change.*
