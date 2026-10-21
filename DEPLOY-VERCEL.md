# Deploy the SCB MCP server on Vercel

Vercel is the first place this server runs for an ElevenLabs agent. Cloud Run stays documented in `DEPLOY-CLOUDRUN.md` for later. Local `pnpm dev` is unchanged: loopback, `MCP_PORT`, and `SCB_CERT_PATH`.

Do not commit the certificate, the password, or the MCP token. Do not put them in `vercel.json`.

The deployment is one Node.js function, `api/mcp.ts`, in region **arn1 (Stockholm)**.

| Public URL | Rewrites to | Auth |
| --- | --- | --- |
| `https://<project>.vercel.app/health` | `/api/mcp?route=health` | open |
| `https://<project>.vercel.app/api/warm` | `/api/mcp?route=warm` | open, or `Bearer CRON_SECRET` when that variable is set |
| `https://<project>.vercel.app/mcp` | `/api/mcp` | `MCP_AUTH_TOKEN` |

`/api/warm` is a rewrite onto `api/mcp.ts`, not its own function, so the cron hits the same Fluid instance as `/mcp` when one is free. It waits for the Firestore company index and returns `{ loaded, count, ageSeconds }`. `vercel.json` schedules that path every 2 minutes. Cron jobs run on production only. Set `CRON_SECRET` in the project; Vercel then sends `Authorization: Bearer <CRON_SECRET>` with the cron request.

`/mcp` is stateless streamable HTTP (JSON). `GET` and `DELETE` return **405**. That matches what ElevenLabs’ Streamable HTTP transport needs, and it does not hold an SSE stream inside the function timeout.

`MCP_EXPOSED_TOOLS=voice` registers `scb_find_company` (name and organisation-number lookup) and `company_website_summary` (official website, short Swedish summary).

## 1. Import the repo

1. In Vercel, **Add New → Project** and import `mgladh96/SCBmcp` (or this GitHub repo).
2. Framework preset: **Other**. There is no Next.js app. Vercel picks up `api/mcp.ts`.
3. Root directory: the repository root.
4. Production branch can stay `main` after this branch is merged. Until then, deploy `cursor/cloudrun-elevenlabs-mcp-ed0b`.
5. Node.js version: **22.x**. `package.json` `engines.node` is `22.x`, which is what Vercel uses. Do not leave the project on the Node 24 default if the dashboard overrides engines.

`vercel.json` already sets `"regions": ["arn1"]`. Stockholm is the EU region next to SCB. One region is valid on Hobby. Extra regions need Pro.

## 2. Environment variables

Mark every secret **Sensitive** so the dashboard will not show the value again after you save it.

| Name | Sensitive | Value |
| --- | --- | --- |
| `SCB_API_ID` | yes | API id from the certificate name (`AXXXXX`) |
| `SCB_CERT_PASSWORD` | yes | pfx password, no trailing newline |
| `SCB_CERT_BASE64` | yes | base64 of the `.pfx`, one line |
| `MCP_AUTH_TOKEN` | yes | long random token. Same value ElevenLabs will send |
| `MCP_EXPOSED_TOOLS` | no | `voice` |
| `TAVILY_API_KEY` | yes | Tavily Search API key. `company_website_summary` uses it when `url` is omitted |
| `OPENAI_API_KEY` | yes | Optional. If set, the website summary is written by `gpt-4o-mini`. If unset, the tool returns extracted Swedish sentences and does not call a model |
| `CRON_SECRET` | yes | Optional. When set, `GET /api/warm` requires `Authorization: Bearer <CRON_SECRET>`. Vercel Cron adds that header itself |

Do not set `SCB_CERT_PATH`. The function decodes `SCB_CERT_BASE64` in memory and does not write the pfx to disk. Vercel’s filesystem is read-only except `/tmp`.

Generate the MCP token locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Apply the variables to **Production** (and Preview if you want preview URLs to work). Redeploy after saving them. A deployment does not pick up new variables until the next build.

### Base64 the pfx

The value is the base64 text, not the binary file. One line. A normal SCB `.pfx` stays far under Vercel’s environment-variable size limit (about 64 KB per value).

```bash
# Linux (GNU coreutils)
base64 -w 0 /path/to/certificate.pfx

# macOS
base64 -i /path/to/certificate.pfx | tr -d '\n'
```

Paste the output into `SCB_CERT_BASE64`. Whitespace in the value is ignored. Do not commit the output.

Password and API id: paste the raw string. If you pipe a file in, make sure it has no trailing newline (`printf '%s'`).

## 3. Deploy

Push the branch (or merge it) and let Vercel build. The install uses `package-lock.json` (`npm`). No custom build command is required. `includeFiles` ships `data/scb-catalog/**` with the function so the offline code catalog is on disk even when the bundler moves the source.

## 4. Test with curl

```bash
BASE=https://<project>.vercel.app
TOKEN='the-mcp-auth-token'

curl -sS "$BASE/health"
# {"ok":true,"transport":"streamable-http","transports":["streamable-http"],"mcp":"/mcp"}

curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# 401

curl -sS -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# JSON-RPC initialize result, HTTP 200

curl -sS -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-03-26' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
# result.tools is scb_find_company and company_website_summary when MCP_EXPOSED_TOOLS=voice
```

A raw `Authorization: $TOKEN` header (no `Bearer` prefix) is also accepted. That is the ElevenLabs secret-token field when you do not type the word Bearer yourself.

To check the three website lookups against production, without printing the token:

```bash
MCP_AUTH_TOKEN="$TOKEN" pnpm website:debug
```

The script calls `company_website_summary` for EAG Entreprenad / Brunflo, Peab / Förslöv, and Treeab Bygg / Östersund, and prints only the tool results. Pass `Name|City` arguments to try other companies. `MCP_URL` overrides the default `https://scb-mcp.vercel.app/mcp`.

## 5. ElevenLabs

MCP must be enabled for the workspace (the first custom MCP server asks you to accept the terms). Zero Retention Mode and HIPAA workspaces cannot use MCP.

In ElevenLabs → MCP server integrations → **Add Custom MCP Server**:

1. **Name:** `SCB företagsregister`
2. **Server URL:** `https://<project>.vercel.app/mcp`
3. **Transport:** Streamable HTTP (`STREAMABLE_HTTP`). Not SSE.
4. **Secret token:** `Bearer <MCP_AUTH_TOKEN>` (the full Authorization header value). Or set HTTP header `X-MCP-Auth` to the token.
5. **Tool approval:** **No approval** (`approval_policy: "auto_approve_all"`). Use that only because `voice` is a read-only lookup. If you clear `MCP_EXPOSED_TOOLS` and expose every tool, switch back to per-tool approval.
6. Save, confirm the tool list is `scb_find_company` and `company_website_summary`, and attach the integration to the agent.

Do not put the token in the URL.

`scb_find_company` arguments:

| Spoken request | Arguments |
| --- | --- |
| Search by name | `{ "name": "Volvo" }` |
| Company details | `{ "organizationNumber": "5560747569" }` |

`company_website_summary` arguments:

| Spoken request | Arguments |
| --- | --- |
| What does the company do? | `{ "name": "IKEA", "city": "Älmhult" }` |
| User already named a site | `{ "name": "IKEA", "url": "https://www.ikea.com/se/sv/" }` |

The tool searches with Tavily when `url` is missing, skips directory sites, and reads the homepage plus up to three internal pages. Tavily has its own 6 second timeout and one retry on a 5xx response. The whole website lookup has a 12 second budget. The spoken field is `summary` (about 600 characters). Without `OPENAI_API_KEY` it uses sentences taken from the pages. Failures are logged with a `reason` and no API key.

## Limits

- **Timeout.** This function sets `maxDuration` to **60 seconds** (`api/mcp.ts` and `vercel.json`). The platform default is 300 seconds on every plan, including Hobby. Hobby cannot go past 300 seconds. Pro and Enterprise can raise a function to 800 seconds (1800 seconds only in the extended-duration beta). Sixty seconds is enough for an SCB lookup and lines up with ElevenLabs’ tool timeout (their default is 30 seconds, maximum 300).
- **Cold starts.** Fluid Compute reuses a warm instance across requests to the same function. `/health`, `/api/warm`, and `/mcp` are that function. A production cron calls `/api/warm` every 2 minutes, waits until the company index is loaded, and keeps the instance from going idle. After a long idle the next request still pays a cold start: Node boot, the MCP SDK, and the Firestore read. There is no minimum-instance setting like Cloud Run.
- **Body size.** Request and response bodies are capped at **4.5 MB**. MCP JSON is far smaller.
- **Region.** `vercel.json` sets `"regions": ["arn1"]`, and the function executes there. `x-vercel-id` looks like `iad1::arn1::…`: the first segment is the edge that accepted the request, the second is the function region. A client in the US shows `iad1` first while the function still runs in Stockholm.
- **SSE.** Do not point ElevenLabs at an SSE URL on Vercel. The handler returns JSON and answers `GET /mcp` with 405 so the invocation ends.
