# Deploy the SCB MCP server on Cloud Run

Vercel is the first deployment. Use [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md) until you move here.

This deploys the server so an ElevenLabs Conversational AI agent can call it as a remote MCP server. Do not commit certificates, passwords, or tokens. The image does not contain them.

Local `pnpm dev` is unchanged: it still binds `127.0.0.1` and `MCP_PORT` (default 3000) and still reads `SCB_CERT_PATH`.

## What ElevenLabs can connect to

ElevenLabs Conversational AI supports both remote MCP transports ([docs](https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp)):

| Transport | API value | URL on this server | Use on Cloud Run |
| --- | --- | --- | --- |
| Streamable HTTP | `STREAMABLE_HTTP` | `https://<service>/mcp` | Yes. Stateless JSON, one request per call. Safe with several instances. |
| SSE | `SSE` (their default) | `https://<service>/sse` | No. Sessions live in memory. The follow-up POST can hit another instance. |

Use **Streamable HTTP** and `/mcp`. `GET` and `DELETE` on `/mcp` return **405** (allowed by the MCP spec) so the service does not hold an SSE stream. `/health` stays open and returns no secrets.

The process listens on `PORT` (Cloud Run sets this, usually 8080). If `PORT` is set and `MCP_HOST` is not, it binds `0.0.0.0`. `MCP_AUTH_TOKEN` is required for that bind.

## Auth

MCP routes (`/mcp`, `/sse`, `/messages`) require `MCP_AUTH_TOKEN`. Any of these headers works:

- `Authorization: Bearer <token>`
- `Authorization: <token>` (raw value)
- `X-MCP-Auth: <token>` (or the header named by `MCP_AUTH_HEADER`)

ElevenLabs **Secret token** is sent as the `Authorization` header value. Put `Bearer <token>` in that field, or put the raw token and rely on the raw-value check. Alternatively set an HTTP header `X-MCP-Auth` to the same token.

Cloud Run is deployed with `--allow-unauthenticated` because Google’s front end does not check identity. The shared token does.

## 1. Project

```bash
gcloud config set project bizmate-ai-specialist
gcloud config set run/region europe-north1
```

The Artifact Registry repo `specialist` in `europe-north1` is assumed to exist:

`europe-north1-docker.pkg.dev/bizmate-ai-specialist/specialist`

The runtime service account is:

`specialist-app@bizmate-ai-specialist.iam.gserviceaccount.com`

## 2. Create secrets

Secret ids (the env var name matches the secret id):

- `SCB_API_ID` — API id from the certificate name (`AXXXXX`)
- `SCB_CERT_PASSWORD` — pfx password
- `SCB_CERT_BASE64` — base64 of the `.pfx`, one line
- `MCP_AUTH_TOKEN` — long random token

`printf '%s'` avoids a trailing newline. A trailing newline in the password will not match SCB.

```bash
PROJECT=bizmate-ai-specialist

create_secret() {
  if ! gcloud secrets describe "$1" --project="$PROJECT" >/dev/null 2>&1; then
    gcloud secrets create "$1" --replication-policy=automatic --project="$PROJECT"
  fi
}

for name in SCB_API_ID SCB_CERT_PASSWORD SCB_CERT_BASE64 MCP_AUTH_TOKEN; do
  create_secret "$name"
done

printf '%s' 'AXXXXX' | gcloud secrets versions add SCB_API_ID --project="$PROJECT" --data-file=-
printf '%s' 'the-pfx-password' | gcloud secrets versions add SCB_CERT_PASSWORD --project="$PROJECT" --data-file=-

# Linux (GNU coreutils). -w 0 keeps the base64 on one line.
base64 -w 0 /path/to/certificate.pfx | gcloud secrets versions add SCB_CERT_BASE64 --project="$PROJECT" --data-file=-

# macOS (no -w). tr strips the line wrap.
# base64 -i /path/to/certificate.pfx | tr -d '\n' | gcloud secrets versions add SCB_CERT_BASE64 --project="$PROJECT" --data-file=-

printf '%s' "$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  | gcloud secrets versions add MCP_AUTH_TOKEN --project="$PROJECT" --data-file=-
```

Replace `AXXXXX`, the password, and the pfx path. Keep the generated `MCP_AUTH_TOKEN` value; ElevenLabs needs the same string. Read it back only in a local shell, not into git:

```bash
gcloud secrets versions access latest --secret=MCP_AUTH_TOKEN --project="$PROJECT"
```

The server decodes `SCB_CERT_BASE64` to a buffer and passes it to TLS. It does not write the pfx to disk. Whitespace in the base64 is ignored. If `SCB_CERT_PATH` is also set and that file exists, the file wins (local usage).

## 3. Grant the runtime service account access

The account may already have `roles/secretmanager.secretAccessor` on the project. These bindings keep access if that project-level role is removed. They do not put secret values in the image or the service spec.

```bash
PROJECT=bizmate-ai-specialist
SA=specialist-app@bizmate-ai-specialist.iam.gserviceaccount.com

for name in SCB_API_ID SCB_CERT_PASSWORD SCB_CERT_BASE64 MCP_AUTH_TOKEN; do
  gcloud secrets add-iam-policy-binding "$name" \
    --project="$PROJECT" \
    --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor"
done
```

## 4. Build and push

```bash
IMAGE=europe-north1-docker.pkg.dev/bizmate-ai-specialist/specialist/scb-foretagsregister-mcp:latest

gcloud auth configure-docker europe-north1-docker.pkg.dev --quiet
docker build -t "$IMAGE" .
docker push "$IMAGE"
```

The image is Node 22 Alpine, multi-stage, and runs as the `node` user. `.dockerignore` excludes `.env`, `*.pfx`, and `*.p12`.

## 5. Deploy

`--allow-unauthenticated` is intentional: the MCP token is the lock. `--min-instances=0` scales to zero. `--max-instances=3` caps SCB quota. Do not set `PORT`; Cloud Run injects it.

`MCP_EXPOSED_TOOLS=voice` registers only `scb_find_company`. Omit that env var to expose every tool (same as local).

```bash
IMAGE=europe-north1-docker.pkg.dev/bizmate-ai-specialist/specialist/scb-foretagsregister-mcp:latest

gcloud run deploy scb-foretagsregister-mcp \
  --project=bizmate-ai-specialist \
  --region=europe-north1 \
  --image="$IMAGE" \
  --service-account=specialist-app@bizmate-ai-specialist.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --port=8080 \
  --timeout=120 \
  --memory=512Mi \
  --cpu=1 \
  --set-env-vars=MCP_HOST=0.0.0.0,MCP_EXPOSED_TOOLS=voice \
  --set-secrets=SCB_API_ID=SCB_API_ID:latest,SCB_CERT_PASSWORD=SCB_CERT_PASSWORD:latest,SCB_CERT_BASE64=SCB_CERT_BASE64:latest,MCP_AUTH_TOKEN=MCP_AUTH_TOKEN:latest
```

```bash
SERVICE_URL="$(gcloud run services describe scb-foretagsregister-mcp \
  --project=bizmate-ai-specialist \
  --region=europe-north1 \
  --format='value(status.url)')"
echo "$SERVICE_URL"
```

## 6. Test with curl

```bash
TOKEN="$(gcloud secrets versions access latest --secret=MCP_AUTH_TOKEN --project=bizmate-ai-specialist)"

curl -sS "$SERVICE_URL/health"
# {"ok":true,"transport":"sse","transports":["sse","streamable-http"],"sse":"/sse","messages":"/messages","mcp":"/mcp"}

curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$SERVICE_URL/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# 401

curl -sS -X POST "$SERVICE_URL/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# JSON-RPC initialize result, HTTP 200
```

A raw `Authorization: $TOKEN` (no Bearer prefix) is also accepted.

## 7. Add it to the ElevenLabs agent

MCP is off until the workspace opts in. The first **Add Custom MCP Server** asks you to accept the MCP terms. Workspaces on Zero Retention Mode or HIPAA cannot use MCP.

In [ElevenLabs → MCP server integrations](https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp):

1. **Name:** `SCB företagsregister`
2. **Server URL:** `https://<service>.run.app/mcp` (the Cloud Run URL plus `/mcp`). Must be `https`.
3. **Transport:** Streamable HTTP (`STREAMABLE_HTTP`). Leave the default SSE unset.
4. **Secret token:** `Bearer <MCP_AUTH_TOKEN>` (the Authorization header value). Or set HTTP header `X-MCP-Auth` to the token and leave the secret empty.
5. **Tool approval:** **No approval**. In the API that is `approval_policy: "auto_approve_all"`. Use that only because the voice preset is a read-only lookup. If you expose the full tool list, prefer per-tool approval so a broad search cannot run unattended.
6. Save, confirm the connection lists `scb_find_company`, then attach the integration to the agent.

Do not put the token in the URL.

## Tools to expose to a voice agent

With `MCP_EXPOSED_TOOLS=voice` the agent sees one tool, `scb_find_company`. That is the lookup to expose:

| Spoken request | Arguments | What comes back |
| --- | --- | --- |
| Search by name | `{ "name": "Volvo" }` | Matching companies (`Företagsnamn` contains the text). Default 5 rows. |
| Company details | `{ "organizationNumber": "5560747569" }` | The company record for that org.nr. Same tool, exact match. There is no separate get-details call. |
| Both | `{ "name": "Volvo", "organizationNumber": "5560747569" }` | AND of the two filters. |

The rows include name, organisation number, status, seat, size class, industry, and `Reklam`. SCB still counts before fetch and refuses more than 2000 hits.

Leave these off a voice agent. They are for a coding agent, they spend SCB quota, and their schemas are easy to mis-call out loud:

- `scb_search_companies` / `scb_count_companies` — same data, but the model must build raw SCB filters
- `scb_query`, `scb_compile_query`, `scb_discover`, `scb_lookup_codes` — industry and geography compilation
- category, variable, and workplace tools

To expose a custom set instead of the preset:

```bash
MCP_EXPOSED_TOOLS=scb_find_company,scb_search_companies
```

Unset `MCP_EXPOSED_TOOLS` to register every tool, including prompts and the operators resource.
