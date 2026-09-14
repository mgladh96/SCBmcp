import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScbClient, type FetchLike } from "../src/scb/client.js";
import type { ScbAuthConfig } from "../src/scb/auth.js";

export function dummyCertPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "scb-cert-"));
  const path = join(dir, "dummy.pfx");
  writeFileSync(path, "not-a-real-pfx");
  return path;
}

export function testAuth(certPath = dummyCertPath()): ScbAuthConfig {
  return {
    apiId: "A12345",
    apiIdHeader: "api-id",
    certPath,
    certPassword: "secret",
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

export function createTestClient(fetchImpl: FetchLike): ScbClient {
  return new ScbClient({
    baseUrl: "https://privateapi.scb.se/nv0101/v1/sokpavar",
    auth: testAuth(),
    fetch: fetchImpl,
    skipCertLoad: true,
    logLevel: "error",
    bypassMetadataCache: false,
  });
}
