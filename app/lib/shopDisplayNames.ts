// B-530: website spelling for shop names in MCP output.
//
// The main app computes with internal names (Rose Bikes, Fahrradteile, …) and converts only at
// display time (getCanonicalShopName). The stub does the same: every shop name a user or model
// SEES goes through displayShopName() at the render boundary. Comparisons, filters, lookups and
// /go/ slug building keep using the RAW API name or shop_id — never convert before those.
//
// Targets are verbatim from the main app's src/config/shops.ts `displayName`.

/** shop_id (product_feeds.shop) → website display name. Only the four ids whose API name differs. */
const DISPLAY_BY_SHOP_ID: Record<string, string> = {
  'rosebikes': 'ROSE Bikes',
  'fahrradteile': 'fahrrad-teile.shop',
  'hibike': 'HiBike',
  'bike-components': 'bike-components',
};

/** lower-cased alias → website display name (the API / shipping_costs spellings, plus the targets themselves). */
const DISPLAY_BY_ALIAS: Record<string, string> = {
  'rose bikes': 'ROSE Bikes',
  'rosebikes': 'ROSE Bikes',
  'rose': 'ROSE Bikes',
  'fahrradteile': 'fahrrad-teile.shop',
  'fahrrad-teile.shop': 'fahrrad-teile.shop',
  'hibike': 'HiBike',
  'bike-components': 'bike-components',
};

/**
 * Website spelling for a shop name. Prefers `shopId` when the row has one, falls back to the
 * case-insensitive alias, and passes unknown names through unchanged (e.g. "Velondo (Fahrrad24)").
 */
export function displayShopName(nameOrId: string, shopId?: string | null): string {
  if (shopId) {
    const byId = DISPLAY_BY_SHOP_ID[shopId.trim().toLowerCase()];
    if (byId) return byId;
  }
  if (typeof nameOrId !== 'string') return nameOrId;
  return DISPLAY_BY_ALIAS[nameOrId.trim().toLowerCase()] ?? nameOrId;
}

/**
 * Free-text API message that embeds the raw shop name ("… ist bei Rose Bikes …"): swap only the
 * exact "bei <raw name> " phrase (raw name taken from the same response), never a generic word like "Fahrradteile".
 */
export function displayShopInMessage(message: string, rawShop?: string | null): string {
  if (!rawShop) return message;
  const shown = displayShopName(rawShop);
  return shown === rawShop ? message : message.split(`bei ${rawShop} `).join(`bei ${shown} `);
}
