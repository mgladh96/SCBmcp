const endpoint = process.env.MCP_URL?.trim() || "https://scb-mcp.vercel.app/mcp";
const token = process.env.MCP_AUTH_TOKEN?.trim() ?? "";

const defaults = [
  { name: "EAG Entreprenad", city: "Brunflo" },
  { name: "Peab", city: "Förslöv" },
  { name: "Treeab Bygg", city: "Östersund" },
];

type Company = { name: string; city?: string };

function companies(): Company[] {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    return defaults;
  }
  return args.map((arg) => {
    const [name, city] = arg.split("|");
    const trimmed = name?.trim() ?? "";
    if (!trimmed) {
      throw new Error("Usage: MCP_AUTH_TOKEN=... pnpm website:debug [Name|City ...]");
    }
    return city?.trim() ? { name: trimmed, city: city.trim() } : { name: trimmed };
  });
}

function redact(text: string): string {
  if (!token) {
    return text;
  }
  return text.split(token).join("[redacted]");
}

async function lookup(company: Company): Promise<void> {
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "company_website_summary", arguments: company },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  let result: unknown = redact(raw);
  try {
    const body = JSON.parse(raw) as {
      result?: { content?: Array<{ text?: string }> };
      error?: { message?: string };
    };
    const text = body.result?.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        result = JSON.parse(text) as unknown;
      } catch {
        result = redact(text);
      }
    } else if (body.error?.message) {
      result = { message: redact(body.error.message) };
    }
  } catch {
    result = redact(raw).slice(0, 500);
  }
  console.log(JSON.stringify({
    name: company.name,
    ...(company.city ? { city: company.city } : {}),
    http: response.status,
    ms: Date.now() - started,
    result,
  }));
}

async function main(): Promise<void> {
  if (!token) {
    console.error("MCP_AUTH_TOKEN is not set");
    process.exit(1);
  }
  for (const company of companies()) {
    try {
      await lookup(company);
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      console.log(JSON.stringify({
        name: company.name,
        ...(company.city ? { city: company.city } : {}),
        result: { message: redact(message) },
      }));
    }
  }
}

await main();
