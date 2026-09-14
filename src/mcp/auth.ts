import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const MCP_AUTH_HEADER = "x-mcp-auth";

export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1];
}

export function providedMcpToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const fromBearer = extractBearerToken(typeof header === "string" ? header : undefined);
  if (fromBearer) {
    return fromBearer;
  }
  const custom = req.headers[MCP_AUTH_HEADER];
  if (typeof custom === "string" && custom.length > 0) {
    return custom;
  }
  if (Array.isArray(custom)) {
    const first = custom[0];
    if (typeof first === "string" && first.length > 0) {
      return first;
    }
  }
  return undefined;
}

export function mcpTokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** When no shared secret is configured, MCP HTTP is allowed (loopback-only startup). */
export function isMcpRequestAuthorized(req: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) {
    return true;
  }
  const provided = providedMcpToken(req);
  if (!provided) {
    return false;
  }
  return mcpTokensEqual(provided, authToken);
}
