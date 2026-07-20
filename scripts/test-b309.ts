/**
 * B-309 acceptance test — MCP stub honest availability for variant-uncertain rows.
 *
 * Drives the REAL exported helpers from app/lib/mcpServer.ts (b309WinnerEligible,
 * b309StockLabel, isVariantUncertain, and the two verbatim German constants) — the same
 * functions the get_best_price and find_alternatives_for_product tools call. The 3-way
 * "best price / all-uncertain / out-of-stock" branch and the trophy `find` are asserted
 * by replaying the exact expressions from the tool code using those real helpers/constants.
 *
 * Run: npx tsx scripts/test-b309.ts
 */
import {
  b309StubUncertainEnabled,
  isVariantUncertain,
  b309WinnerEligible,
  b309StockLabel,
  B309_LABEL_UNCERTAIN,
  B309_ALL_UNCERTAIN_LINE,
} from "../app/lib/mcpServer";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

type Row = { shop_id: string; price: number; in_stock: boolean; variantUncertain?: boolean };

// Exact M1 production row set for EAN 0710845862380 (SRAM HS2), price-sorted.
const M1_ROWS: Row[] = [
  { shop_id: "bike24",          price: 32.99, in_stock: true,  variantUncertain: true },
  { shop_id: "bike-components", price: 32.99, in_stock: false },
  { shop_id: "boc24",           price: 39.99, in_stock: true },
  { shop_id: "fahrradxxl",      price: 39.99, in_stock: true },
  { shop_id: "fahrradteile",    price: 45.65, in_stock: true },
  { shop_id: "maciag",          price: 49.95, in_stock: true },
];

// The pre-B-309 ("today") derivations, replayed verbatim from f261ca7:
const todayWinner = (rows: Row[]) => rows.find(r => r.in_stock) ?? null;
const todayLabel = (r: Row) => (r.in_stock ? "✅" : "❌");
// The real B-309 winner selection, exactly as the tools call it (results.find(b309WinnerEligible)):
const b309Winner = (rows: Row[]) => rows.find(b309WinnerEligible) ?? null;

// The real 3-way content line, exactly as get_best_price/find_alternatives build it:
function outOfStockOrUncertainLine(rows: Row[], todayLineWhenNone: string): string {
  const cheapestInStock = b309Winner(rows);
  const hasUncertain = rows.some(r => isVariantUncertain(r));
  if (cheapestInStock) return `WINNER:${cheapestInStock.shop_id}`;
  return hasUncertain ? B309_ALL_UNCERTAIN_LINE : todayLineWhenNone;
}
const GBP_OOS = "**Currently out of stock at every shop listed — no in-stock best price available.**";

function withFlag(v: string | undefined, fn: () => void) {
  const prev = process.env.B309_STUB_UNCERTAIN_ENABLED;
  if (v === undefined) delete process.env.B309_STUB_UNCERTAIN_ENABLED;
  else process.env.B309_STUB_UNCERTAIN_ENABLED = v;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.B309_STUB_UNCERTAIN_ENABLED;
    else process.env.B309_STUB_UNCERTAIN_ENABLED = prev;
  }
}

const uncertainInStock: Row = { shop_id: "bike24", price: 10, in_stock: true, variantUncertain: true };
const uncertainOOS: Row     = { shop_id: "bike24", price: 10, in_stock: false, variantUncertain: true };
const certainInStock: Row   = { shop_id: "boc24",  price: 20, in_stock: true };
const certainOOS: Row       = { shop_id: "boc24",  price: 20, in_stock: false };
const fieldFalseInStock: Row= { shop_id: "boc24",  price: 20, in_stock: true, variantUncertain: false };

console.log("\nB-309 acceptance\n");

// ── FLAG OFF (unset) — everything byte-identical to today ────────────────────────
console.log("[flag OFF — unset]");
withFlag(undefined, () => {
  assert(b309StubUncertainEnabled() === false, "flag getter false when unset");
  assert(isVariantUncertain(uncertainInStock) === false, "isVariantUncertain false when flag OFF even if field true");
  // winner + label identical to today across the M1 set
  assert(b309Winner(M1_ROWS)?.shop_id === todayWinner(M1_ROWS)?.shop_id, "winner == today (bike24 crowned)");
  assert(b309Winner(M1_ROWS)?.shop_id === "bike24", "OFF: bike24 is still crowned (today's behaviour)");
  assert(M1_ROWS.every(r => b309StockLabel(r) === todayLabel(r)), "every row label == today (✅/❌)");
  assert(outOfStockOrUncertainLine([uncertainOOS], GBP_OOS) === GBP_OOS, "OFF: all-uncertain edge falls back to today's OOS line");
});

// ── FLAG ON, field ABSENT — byte-identical to today ───────────────────────────────
console.log("[flag ON — field absent on all rows]");
withFlag("true", () => {
  const rows: Row[] = [certainOOS, certainInStock]; // no variantUncertain field anywhere
  assert(b309Winner(rows)?.shop_id === todayWinner(rows)?.shop_id, "field-absent: winner == today");
  assert(rows.every(r => b309StockLabel(r) === todayLabel(r)), "field-absent: labels == today");
});

// ── FLAG ON, field FALSE — byte-identical to today ────────────────────────────────
console.log("[flag ON — field present and false]");
withFlag("true", () => {
  assert(isVariantUncertain(fieldFalseInStock) === false, "field false ⇒ not uncertain");
  assert(b309WinnerEligible(fieldFalseInStock) === true, "field false in-stock ⇒ winner-eligible (today)");
  assert(b309StockLabel(fieldFalseInStock) === "✅", "field false in-stock ⇒ ✅ (today)");
});

// ── FLAG ON, field TRUE — the downgrade ───────────────────────────────────────────
console.log("[flag ON — field true (downgrade)]");
withFlag("true", () => {
  assert(isVariantUncertain(uncertainInStock) === true, "field true + flag ON ⇒ uncertain");
  // precedence rule 1: overrides in_stock in BOTH directions
  assert(b309WinnerEligible(uncertainInStock) === false, "uncertain in_stock=true ⇒ NEVER crowned");
  assert(b309WinnerEligible(uncertainOOS) === false, "uncertain in_stock=false ⇒ still never crowned");
  assert(b309StockLabel(uncertainInStock) === B309_LABEL_UNCERTAIN, "uncertain in_stock=true ⇒ label 'Verfügbarkeit prüfen', not ✅");
  assert(b309StockLabel(uncertainOOS) === B309_LABEL_UNCERTAIN, "uncertain in_stock=false ⇒ label 'Verfügbarkeit prüfen', not ❌");
  // certain rows untouched
  assert(b309StockLabel(certainInStock) === "✅", "certain in-stock row ⇒ ✅ unchanged");
  assert(b309StockLabel(certainOOS) === "❌", "certain out-of-stock row ⇒ ❌ unchanged");
  assert(b309WinnerEligible(certainInStock) === true, "certain in-stock row ⇒ winner-eligible");
  // M1 set: trophy moves off bike24 to the cheapest certain in-stock shop = boc24
  assert(b309Winner(M1_ROWS)?.shop_id === "boc24", "M1: trophy moves bike24 → boc24 (matches API cheapest)");
});

// ── ALL-UNCERTAIN edge ────────────────────────────────────────────────────────────
console.log("[flag ON — all in-stock rows uncertain]");
withFlag("true", () => {
  const allUncertain: Row[] = [uncertainInStock, { shop_id: "bike-discount", price: 12, in_stock: true, variantUncertain: true }];
  assert(b309Winner(allUncertain) === null, "no winner when every in-stock row is uncertain");
  assert(outOfStockOrUncertainLine(allUncertain, GBP_OOS) === B309_ALL_UNCERTAIN_LINE, "emits ⚠️ all-uncertain line, NOT the OOS line");
});

console.log("[flag ON — no in-stock row AND no uncertain row]");
withFlag("true", () => {
  const allOOS: Row[] = [certainOOS, { shop_id: "maciag", price: 30, in_stock: false }];
  assert(b309Winner(allOOS) === null, "no winner when all out of stock");
  assert(outOfStockOrUncertainLine(allOOS, GBP_OOS) === GBP_OOS, "genuine OOS ⇒ today's OOS line unchanged");
});

// ── Verbatim constants ────────────────────────────────────────────────────────────
console.log("[verbatim strings]");
assert(B309_LABEL_UNCERTAIN === "🔍 Verfügbarkeit prüfen", "row label verbatim");
assert(
  B309_ALL_UNCERTAIN_LINE ===
    "⚠️ Kein Shop mit bestätigter Verfügbarkeit — bei den mit „Verfügbarkeit prüfen“ markierten Zeilen ist die Variantenzuordnung nicht gesichert.",
  "all-uncertain line verbatim",
);

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
