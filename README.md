# bikefuchs-mcp-stub

> **This is not the real Bikefuchs MCP server.**
> It is a namespace-defense placeholder that reserves `@bikefuchs` on Smithery while the production server is developed. It exposes one informational tool and nothing else.

## What this exposes

One tool: **`get_info`**

Returns a text message with the Bikefuchs launch status, the list of tools that will be available in the real server, and a link to [bikefuchs.de](https://bikefuchs.de).

## When the real server launches

Q3 2026, following the public launch of [bikefuchs.de](https://bikefuchs.de). The production server will include tools for cart optimization, product search, EAN lookup, and shop info across 5+ German/Austrian bike shops. This repo will be replaced or superseded at that point.

## Connect remotely (Claude Desktop)

The canonical entry point is the Vercel deployment. Use `mcp-remote` to proxy it into Claude Desktop:

```json
{
  "mcpServers": {
    "bikefuchs": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.bikefuchs.com/mcp"
      ]
    }
  }
}
```

Add this to your `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`).

## Initial deployment checklist

Follow this order exactly. Smithery verifies the live URL during publishing — publishing before DNS is configured will fail.

1. **Push to GitHub**
   ```
   git remote add origin https://github.com/bikefuchs/bikefuchs-mcp-stub.git
   git push -u origin main
   ```

2. **Import into Vercel**
   Log into Vercel with an account that has access to the `bikefuchs` GitHub org (not a personal account). Import `bikefuchs/bikefuchs-mcp-stub`. Default Next.js settings are correct — no env vars required.

3. **Deploy on Vercel**
   Trigger the first deploy. Confirm the build succeeds and the default `.vercel.app` URL returns a valid MCP response.

4. **Add custom domain in Vercel**
   In the Vercel project → Settings → Domains, add `mcp.bikefuchs.com`.

5. **Configure DNS in Strato**
   Under bikefuchs.com, create a subdomain `mcp` and set a CNAME record pointing to the value Vercel provides (typically `cname.vercel-dns.com`). Allow up to 30 minutes for propagation.

6. **Verify the live endpoint**
   ```
   curl -i https://mcp.bikefuchs.com/mcp
   ```
   Expected: HTTP 2xx or 4xx with a valid MCP response body — not a 404 or connection refused.

7. **Publish on Smithery** ← do this last
   Log into [smithery.ai](https://smithery.ai) using the `bikefuchs` GitHub org. Submit the repo URL `https://github.com/bikefuchs/bikefuchs-mcp-stub`. Set the namespace to `@bikefuchs` in the Smithery dashboard.

## Links

- [bikefuchs.de](https://bikefuchs.de) — live bike price comparison
- [Smithery listing](https://smithery.ai/server/@bikefuchs/bikefuchs-stub) — available after step 7
- [MCP specification](https://modelcontextprotocol.io)
