/**
 * B-422 acceptance test — variant label directive + variantSegment formatting.
 *
 * Drives the REAL exports from app/lib/mcpServer.ts (variantSegment, the directive
 * constant, and the four tell_user values) — the same values the tools emit, never a
 * copy. A copied expectation is how the two sides drift apart (B-072).
 *
 * Covers:
 *   [A] variantSegment formats " · <colour> · <size>" and degrades to '' honestly.
 *   [B] VARIANT_LABEL_DIRECTIVE reaches the three openai tell_user values that belong
 *       to label-bearing tools, and does NOT reach optimize_cart's (no labels there
 *       today — that is B-421).
 *
 * Run: npx tsx scripts/test-b422.ts
 */
import {
  variantSegment,
  VARIANT_LABEL_DIRECTIVE,
  TELL_USER_SEARCH,
  TELL_USER_ALTERNATIVES,
  PILOT_TELL_USER_BEST_PRICE,
  PILOT_TELL_USER_OPTIMIZE_CART,
} from "../app/lib/mcpServer";

let failures = 0;
function assert(cond: boolean, msg: string, detail = "") {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ FAIL: ${msg}${detail}`);
  }
}

// ── [A] variantSegment formatting ─────────────────────────────────────────────────
// Real production values: bmo stores "172,5 mm" (crank length) under variant_size for
// EAN 0710845915598 while bike-components stores "42" (chainring teeth) — the reason
// the segment carries NO axis name. The colour-before-size order is asserted here.
console.log("[A] variantSegment formatting");
{
  const both = variantSegment({ variant_colour: "Standard", variant_size: "Ø160mm" });
  assert(both === " · Standard · Ø160mm", "colour + size ⇒ ' · <colour> · <size>' (colour first)", `\n      got: ${JSON.stringify(both)}`);

  const colourOnly = variantSegment({ variant_colour: "black", variant_size: null });
  assert(colourOnly === " · black", "colour only ⇒ ' · <colour>'", `\n      got: ${JSON.stringify(colourOnly)}`);

  const sizeOnly = variantSegment({ variant_colour: null, variant_size: "XXL" });
  assert(sizeOnly === " · XXL", "size only ⇒ ' · <size>'", `\n      got: ${JSON.stringify(sizeOnly)}`);

  const neither = variantSegment({ variant_colour: null, variant_size: null });
  assert(neither === "", "both null ⇒ '' (line byte-identical to pre-B-412)", `\n      got: ${JSON.stringify(neither)}`);

  const absent = variantSegment({});
  assert(absent === "", "both absent (older API / scraped row) ⇒ ''", `\n      got: ${JSON.stringify(absent)}`);

  // Empty strings are falsy — they must not produce a bare " · " separator.
  const empty = variantSegment({ variant_colour: "", variant_size: "" });
  assert(empty === "", "empty strings ⇒ '' (never a dangling ' · ')", `\n      got: ${JSON.stringify(empty)}`);
}

// ── [B] directive reaches the openai structured reader ────────────────────────────
// Claude reads only `content`; ChatGPT reads `structuredContent`. The directive is
// emitted in the content block of search_product / get_best_price / find_alternatives
// AND folded into these tell_user values, so both channels receive it (parity rule).
console.log("\n[B] VARIANT_LABEL_DIRECTIVE in tell_user values");
{
  assert(TELL_USER_SEARCH.includes(VARIANT_LABEL_DIRECTIVE), "TELL_USER_SEARCH carries the directive");
  assert(PILOT_TELL_USER_BEST_PRICE.includes(VARIANT_LABEL_DIRECTIVE), "PILOT_TELL_USER_BEST_PRICE carries the directive");
  assert(TELL_USER_ALTERNATIVES.includes(VARIANT_LABEL_DIRECTIVE), "TELL_USER_ALTERNATIVES carries the directive");
  assert(
    !PILOT_TELL_USER_OPTIMIZE_CART.includes(VARIANT_LABEL_DIRECTIVE),
    "PILOT_TELL_USER_OPTIMIZE_CART does NOT carry it (optimize_cart emits no labels — B-421)",
  );
}

// ── [C] directive wording guards ──────────────────────────────────────────────────
// The two honesty properties the wording exists for. If someone later "tightens" the
// text into a universal claim, these fail.
console.log("\n[C] directive wording");
{
  assert(/\bSome product lines\b/.test(VARIANT_LABEL_DIRECTIVE), "says SOME lines carry a label (never claims all do)");
  assert(/Never add a label to a line that has none/.test(VARIANT_LABEL_DIRECTIVE), "forbids inventing a label (Honest Floor)");
  assert(/do not rewrite product names/.test(VARIANT_LABEL_DIRECTIVE), "forbids rewriting product names");
  assert(!VARIANT_LABEL_DIRECTIVE.startsWith("\n") && !VARIANT_LABEL_DIRECTIVE.endsWith("\n"),
         "constant carries no leading/trailing newline (separators live in the templates)");
  // Appended to TELL_USER_SEARCH after PRESENT_LIST_DIRECTIVE — exactly once, not twice.
  const occurrences = TELL_USER_SEARCH.split(VARIANT_LABEL_DIRECTIVE).length - 1;
  assert(occurrences === 1, "TELL_USER_SEARCH carries it exactly once", `\n      got: ${occurrences}`);
}

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
