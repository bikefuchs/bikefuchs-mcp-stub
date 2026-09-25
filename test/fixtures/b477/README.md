# B-477 production golden files

Captured from production (commit `993321c4`, deployment `dpl_NK8xCc1vo4fjEMMuUQ8vkivamxkV`)
on 2026-09-25 between 13:00:53 and 13:02:04 UTC, one request every 6 s, with:

    curl -s -D <name>.headers.txt -o <name>.body.txt -X POST <url> \
      -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      --data-binary @<name>.request.json

`mcp__*` = https://mcp.bikefuchs.com/mcp, `mcp_openai__*` = https://mcp.bikefuchs.com/mcp/openai.
Cases: a–c initialize (2025-06-18 / 2025-03-26 / 2024-11-05), d notifications/initialized,
e ping, f server/discover (recorded only; not handled by the early exit).

`test/b477-parity.test.ts` asserts the early exit reproduces a–e byte for byte. If a
deliberate change to serverInfo, instructions or capabilities lands, re-capture these
files from production after the deploy; never hand-edit them.
