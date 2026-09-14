# SCB Allmänna företagsregister MCP server

MCP server that exposes **SCB:s Allmänna företagsregister** to AI agents.

It is only a data access layer for that API. It does not search other sources, enrich records, scrape websites, or run an LLM.

## What this server does

An agent can:

1. Inspect categories and variables the configured SCB account may use
2. Resolve code tables for a category
3. Count companies (JE, juridisk enhet)
4. Retrieve companies when the match count is ≤ 2,000
5. Count workplaces (AE, arbetsställe)
6. Retrieve workplaces

JE and AE stay explicit. They are not hidden behind generic “provider” types.

## Architecture

```
AI Agent
   ↓
MCP Server (HTTP + SSE)
http://127.0.0.1:3000/sse
   ↓
SCB Client (mTLS, rate limit, 2,000-row guard)
   ↓
SCB Allmänna företagsregister API
https://privateapi.scb.se/nv0101/v1/sokpavar/
```

The MCP layer validates tool input and returns JSON. The SCB client owns HTTP, the client certificate, endpoint paths, and POST body serialization.

## Requirements

- Node.js 22+
- pnpm
- An SCB client certificate (`.pfx`) and password issued by SCB
- The API-id from the certificate name (`AXXXXX`)

Request access via [SCB:s information about the API](https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/avgiftsfria-uppgifter-i-foretagsregistret/) (`scbforetag@scb.se`).

## SCB certificate configuration

SCB authenticates with a client certificate, not a login form.

1. Store the `.pfx` file somewhere the MCP process can read. Do not commit it.
2. Keep the password in the environment, never in source.
3. Use `SCB_API_ID` from the certificate name (`AXXXXX`).

Certificate handling lives in `src/scb/auth.ts`. The rest of the server never sees the private key bytes except through the TLS dispatcher.

Help pages (certificate required):

- https://privateapi.scb.se/nv0101/v1/sokpavar/help
- https://privateapi.scb.se/nv0101/v1/sokpavar/help/exampleJe
- https://privateapi.scb.se/nv0101/v1/sokpavar/help/exampleAe

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `SCB_BASE_URL` | no | Default `https://privateapi.scb.se/nv0101/v1/sokpavar` |
| `SCB_API_ID` | yes | API-id from the certificate name |
| `SCB_CERT_PATH` | yes | Path to the `.pfx` file |
| `SCB_CERT_PASSWORD` | yes | Certificate password |
| `SCB_API_ID_HEADER` | no | Header name for the API-id. Default `api-id`. Confirm against SCB help if calls are rejected. |
| `SCB_LOG_LEVEL` | no | `debug`, `info`, or `error`. Logs go to stderr. |
| `MCP_HOST` | no | Bind address. Default `127.0.0.1`. Use `0.0.0.0` to listen on all interfaces. |
| `MCP_PORT` | no | HTTP port. Default `3000`. |
| `SCB_LIVE_TESTS` | no | Set to `true` only when running live SCB tests |

Copy `.env.example`. Do not put secrets in git.

## Installation

```bash
pnpm install
```

## Running locally

```bash
pnpm dev
```

Or build:

```bash
pnpm build
pnpm start
```

The process is an HTTP server. MCP uses **SSE**:

- Health / URL info: `http://127.0.0.1:3000/health`
- SSE (clients connect here): `http://127.0.0.1:3000/sse`
- Message POST: `http://127.0.0.1:3000/messages?sessionId=...`

Logs go to stderr.

## Connecting from Cursor / Claude / another MCP client

Start this server first, then point the client at the SSE URL. Example Cursor config is in `examples/mcp.json`:

```json
{
  "mcpServers": {
    "scb-foretagsregister": {
      "url": "http://127.0.0.1:3000/sse"
    }
  }
}
```

SCB certificate settings stay in the server process environment (`.env`), not in the MCP client config.

## Available MCP tools

| Tool | Purpose |
| --- | --- |
| `scb_list_categories` | Categories for `company` (JE) or `workplace` (AE). Optional `includeCodeTables`. |
| `scb_get_category_values` | Code table for one SCB category |
| `scb_list_variables` | Variables for the account. Optional `includeValueMetadata`. |
| `scb_count_companies` | Count JE matches |
| `scb_search_companies` | Fetch JE matches (counts first; refuses > 2,000) |
| `scb_count_workplaces` | Count AE matches |
| `scb_search_workplaces` | Fetch AE matches (counts first; refuses > 2,000) |

Filter contract (close to SCB, not a natural-language DSL):

```json
{
  "filters": {
    "categories": [{ "category": "Företagsstatus", "values": ["1"] }],
    "variables": [
      {
        "variable": "Företagsnamn",
        "operator": "Innehaller",
        "value": "Bygg",
        "value2": ""
      }
    ]
  }
}
```

Use category and variable **names as SCB returns them** from the metadata tools. Do not hardcode a private schema. Operators are passed through to SCB; confirm legal operators on the SCB help pages.

Search tools return SCB field names as received, including `Reklam` when SCB includes it. This server does not strip marketing restrictions and is not a way to bypass them.

## Example agent workflow

User: “Find active construction companies in Gävleborg with 10-49 employees.”

The **agent** (not this server) should:

1. `scb_list_categories` / `scb_list_variables` for `objectType: "company"` (and workplaces if the question is really about AE)
2. `scb_get_category_values` for SNI/bransch, län, företagsstatus, employee size class, and any other needed category
3. `scb_count_companies` with those codes
4. If count is 0, stop. If count > 2000, narrow filters. If count ≤ 2000, continue
5. `scb_search_companies`
6. Reason over the returned SCB JSON

Gävleborg is a **län** on arbetsställe in SCB’s variabelbeskrivning; säteslän is the company-level equivalent. The agent must take that from SCB metadata, not from this README.

## SCB limits

- Maximum **2,000** rows per retrieve call
- **No pagination**
- **10** calls per **10 seconds** per user
- HTTP **503** during outages
- Current information only (no history in this API)

If count > 2,000, tools return:

```json
{
  "code": "QUERY_TOO_BROAD",
  "message": "...",
  "retryable": false,
  "details": {
    "count": 8432,
    "maxResults": 2000,
    "suggestion": "Narrow the query using additional SCB filters."
  }
}
```

The client also rate-limits outbound calls to stay within 10 / 10s.

## Running tests

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Live SCB tests are **not** part of `pnpm test`. They need a real certificate and:

```bash
# PowerShell
$env:SCB_LIVE_TESTS="true"
pnpm test:live
```

## Errors

Machine-readable JSON:

- `SCB_AUTH_ERROR`
- `SCB_RATE_LIMITED`
- `SCB_UNAVAILABLE`
- `SCB_INVALID_QUERY`
- `SCB_UNKNOWN_CATEGORY`
- `SCB_UNKNOWN_VARIABLE`
- `QUERY_TOO_BROAD`
- `SCB_RESPONSE_VALIDATION_ERROR`

## Live SCB verification

Certificate auth, JE/AE metadata, kodtabell, and `raknaforetag` have been verified against the live SCB API with a real `.pfx`. POST bodies follow `/help/exampleJe`. Search of result sets larger than 2,000 is refused (`QUERY_TOO_BROAD`); that path should be checked with a narrow filter.
