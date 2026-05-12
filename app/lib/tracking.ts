import Umami from "@umami/node";

const websiteId = process.env.UMAMI_WEBSITE_ID;

if (websiteId) {
  Umami.init({ websiteId, hostUrl: "https://cloud.umami.is" });
}

export function trackMcpEvent(
  eventName: string,
  data?: Record<string, string | number>
): void {
  if (!websiteId) return;
  try {
    Umami.track({ name: eventName, data });
  } catch (err) {
    console.error("[MCP] Tracking error:", err);
  }
}
