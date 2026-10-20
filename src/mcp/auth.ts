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

/**
 * Token from an Authorization header.
 * Accepts `Bearer <token>` and a raw token (ElevenLabs secret token is the
 * Authorization header value, with or without a Bearer prefix).
 * Other schemes such as Basic are ignored.
 */
export function tokenFromAuthorization(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const trimmed = authorization.trim();
  if (!trimmed) {
    return undefined;
  }
  const bearer = extractBearerToken(trimmed);
  if (bearer) {
    return bearer;
  }
  if (/^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*\s+\S/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function tokenFromHeaderValue(value: string): string | undefined {
  const bearer = extractBearerToken(value);
  if (bearer) {
    return bearer;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function providedMcpToken(req: IncomingMessage, authHeader = MCP_AUTH_HEADER): string | undefined {
  return credentialFromHeaders(
    {
      get(name: string) {
        const value = req.headers[name.toLowerCase()];
        if (typeof value === "string") {
          return value;
        }
        if (Array.isArray(value)) {
          return value[0] ?? null;
        }
        return null;
      },
    },
    authHeader,
  );
}

type HeaderLookup = { get(name: string): string | null };

function credentialFromHeaders(headers: HeaderLookup, authHeader: string): string | undefined {
  const fromAuthorization = tokenFromAuthorization(headers.get("authorization") ?? undefined);
  if (fromAuthorization) {
    return fromAuthorization;
  }
  const headerName = authHeader.trim().toLowerCase();
  if (!headerName || headerName === "authorization") {
    return undefined;
  }
  const custom = headers.get(headerName);
  if (!custom) {
    return undefined;
  }
  return tokenFromHeaderValue(custom);
}

/** Same rules as the Node HTTP server, for Web `Request` headers (Vercel). */
export function isWebRequestAuthorized(
  headers: HeaderLookup,
  authToken: string | undefined,
  authHeader = MCP_AUTH_HEADER,
): boolean {
  if (!authToken) {
    return true;
  }
  const provided = credentialFromHeaders(headers, authHeader);
  if (!provided) {
    return false;
  }
  return mcpTokensEqual(provided, authToken);
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
export function isMcpRequestAuthorized(
  req: IncomingMessage,
  authToken: string | undefined,
  authHeader = MCP_AUTH_HEADER,
): boolean {
  return isWebRequestAuthorized(
    {
      get(name: string) {
        const value = req.headers[name.toLowerCase()];
        if (typeof value === "string") {
          return value;
        }
        if (Array.isArray(value)) {
          return value[0] ?? null;
        }
        return null;
      },
    },
    authToken,
    authHeader,
  );
}
