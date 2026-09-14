import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { loadConfig, loadEnvFiles } from "../src/config/env.js";
import { createLogger } from "../src/log.js";
import { createSseHttpServer } from "../src/mcp/http.js";
import { createMcpServer, createToolHandlers } from "../src/mcp/server.js";
import { ScbClient } from "../src/scb/client.js";

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  const log = createLogger("error");
  const scb = new ScbClient({
    baseUrl: config.baseUrl,
    auth: {
      apiId: config.apiId,
      apiIdHeader: config.apiIdHeader,
      certPath: config.certPath,
      certPassword: config.certPassword,
    },
    logLevel: "error",
  });
  const httpServer = createSseHttpServer({
    createMcpServer: () => createMcpServer(createToolHandlers(scb, log)),
    log,
    ...(config.authToken ? { authToken: config.authToken } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
    httpServer.once("error", reject);
  });
  const port = (httpServer.address() as AddressInfo).port;
  const sseUrl = new URL(`http://127.0.0.1:${port}/sse`);

  const client = new Client({ name: "scb-sse-smoke", version: "0.1.0" });
  const transport = new SSEClientTransport(sseUrl, {
    ...(config.authToken
      ? { requestInit: { headers: { Authorization: `Bearer ${config.authToken}` } } }
      : {}),
  });
  await client.connect(transport);

  const tools = await client.listTools();
  const listed = await client.callTool({
    name: "scb_list_categories",
    arguments: { objectType: "company" },
  });
  const listedText = JSON.parse(
    (listed.content[0] && listed.content[0].type === "text" ? listed.content[0].text : "{}") as string,
  ) as {
    items?: unknown[];
    categories?: { Kategorier?: unknown[] };
    objectType?: string;
  };

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: listed.isError !== true,
        url: sseUrl.href,
        tools: tools.tools.map((tool) => tool.name),
        prompts: (await client.listPrompts()).prompts.map((prompt) => prompt.name),
        listObjectType: listedText.objectType,
        categoryCount: listedText.items?.length ?? listedText.categories?.Kategorier?.length,
      },
      null,
      2,
    )}\n`,
  );

  await client.close();
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
