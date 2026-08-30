/**
 * Known MCP health-probe allowlist (B-366) — traffic from these addresses is
 * SKIPPED by the rate-limiter (Chokepoint 2) when the flag is on.
 *
 * WHAT THESE ARE
 *   Two third-party monitoring services that poll the MCP transport endpoints to
 *   report uptime. They perform HANDSHAKES ONLY (initialize / tools/list); they
 *   never call a product tool and therefore never receive an EAN. They harvest
 *   nothing, yet each request currently pays the full two-round-trip rate-limit
 *   path (app/lib/rateLimit.ts:46 then :50).
 *
 * HOW THEY WERE IDENTIFIED (2026-08-29)
 *   By an EXACT match between the firewall's per-IP request count and the
 *   per-User-Agent request count for the corresponding agent string. The two
 *   counts agreeing exactly is what ties each User-Agent to a single address.
 *
 * ⚠️ THIS LIST GOES SILENTLY INEFFECTIVE IF THEY MOVE
 *   Neither operator publishes a stable egress range, and neither has committed
 *   to these addresses. If a probe changes IP, it simply stops matching: no error,
 *   no alarm, and it quietly returns to paying the full rate-limit path. That
 *   failure is INVISIBLE in isolation — which is precisely what the B-366 shadow
 *   log detects. A daily count of the shadow marker that drops to zero means the
 *   address moved, not that the traffic stopped.
 *
 * SEPARATE FROM aiEgressCidrs.ts BY DESIGN
 *   That file is hand-synced from OpenAI's and Anthropic's PUBLISHED ranges and
 *   carries its own sync date. These probe addresses have no such provenance and
 *   must never be mixed into it — doing so would destroy the meaning of that
 *   file's "Last synced" line. The matching code below is duplicated from it on
 *   purpose (B-366): the two lists stay independent and can be edited or removed
 *   without touching each other.
 */

// Single addresses (/32), not ranges — we have evidence for exactly these hosts.
const PROBE_CIDRS = [
  '15.204.10.2/32',   // Glimind SentinelOracle/0.1 — MCP reliability oracle probe
  '65.21.92.231/32',  // mcpbeat/0.1 — MCP liveness probe
];

// Pre-parse CIDRs to [network, mask] integer pairs once at module load.
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

const PARSED: Array<[number, number]> = PROBE_CIDRS.map((cidr) => {
  const [net, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const netInt = ipv4ToInt(net);
  if (netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return [0, 0xffffffff] as [number, number]; // never-matches sentinel
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [(netInt & mask) >>> 0, mask];
});

/** True if the (IPv4) IP is a known MCP health probe. */
export function isProbeEgress(ip: string): boolean {
  const v = ipv4ToInt(ip);
  if (v === null) return false; // IPv6 / unknown → not allowlisted (gets limited)
  for (const [net, mask] of PARSED) {
    if (((v & mask) >>> 0) === net) return true;
  }
  return false;
}
