import { describe, expect, it } from "vitest";
import {
  luhn10,
  normalizeCfarNr,
  normalizeIdentityInFilters,
  normalizePeOrgNr,
  redactIdentity,
} from "../src/scb/identity.js";

/** IKEA Svenska Försäljnings AB organisationsnummer (Luhn-ok). */
const ORG10 = "5560747569";
const PEORG12 = `16${ORG10}`;

describe("PeOrgNr 10↔12", () => {
  it("pads a 10-digit organisationsnummer with legal-person prefix 16", () => {
    expect(luhn10(ORG10)).toBe(true);
    const result = normalizePeOrgNr("556074-7569");
    expect(result).toMatchObject({ ok: true, value: PEORG12, fromLength: 10, personnummerLike: false });
  });

  it("keeps a 12-digit PeOrgNr that already has prefix 16", () => {
    const result = normalizePeOrgNr(PEORG12);
    expect(result).toMatchObject({ ok: true, value: PEORG12, fromLength: 12 });
  });

  it("accepts spaces in 10-digit input", () => {
    expect(normalizePeOrgNr("556 074 7569")).toMatchObject({ ok: true, value: PEORG12 });
  });

  it("converts 12-digit PeOrgNr to 10-digit OrgNr in filters", () => {
    const prepared = normalizeIdentityInFilters(
      {
        categories: [],
        variables: [{ variable: "OrgNr (10 siffror)", operator: "ArLikaMed", value: PEORG12 }],
      },
      "company",
    );
    expect(prepared.error).toBeUndefined();
    expect(prepared.filters.variables[0]?.value).toBe(ORG10);
  });
});

describe("identity garbage", () => {
  it("rejects letters and mixed garbage", () => {
    expect(normalizePeOrgNr("not-a-number").ok).toBe(false);
    expect(normalizePeOrgNr("org5560747569").ok).toBe(false);
    expect(normalizePeOrgNr("").ok).toBe(false);
  });

  it("rejects wrong lengths", () => {
    expect(normalizePeOrgNr("12345").ok).toBe(false);
    expect(normalizePeOrgNr("556074756").ok).toBe(false);
    expect(normalizePeOrgNr("55607475690").ok).toBe(false);
    expect(normalizePeOrgNr("1655607475690").ok).toBe(false);
  });

  it("rejects 10-digit personnummer-like values without century", () => {
    const result = normalizePeOrgNr("8501011234");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("IDENTITY_AMBIGUOUS");
    }
  });

  it("rejects bad checksum", () => {
    expect(normalizePeOrgNr("5560747568").ok).toBe(false);
  });
});

describe("CfarNr", () => {
  it("accepts 8 digits and rejects other lengths", () => {
    expect(normalizeCfarNr("12345678")).toMatchObject({ ok: true, value: "12345678" });
    expect(normalizeCfarNr("1234-5678")).toMatchObject({ ok: true, value: "12345678" });
    expect(normalizeCfarNr("1234567").ok).toBe(false);
    expect(normalizeCfarNr("123456789").ok).toBe(false);
  });
});

describe("filter sugar and redaction", () => {
  it("normalizes PeOrgNr in filters and warns when operator is not ArLikaMed", () => {
    const prepared = normalizeIdentityInFilters(
      {
        categories: [],
        variables: [{ variable: "PeOrgNr", operator: "Innehaller", value: "556074-7569" }],
      },
      "company",
    );
    expect(prepared.filters.variables[0]?.value).toBe(PEORG12);
    expect(prepared.warnings.join(" ")).toMatch(/ArLikaMed/);
  });

  it("redacts personnummer-like PeOrgNr", () => {
    const core = findLuhn("850101239");
    const pe = `19${core}`;
    expect(redactIdentity(pe)).toBe("[redacted-identity]");
    expect(redactIdentity(ORG10)).toMatch(/…/);
  });
});

function findLuhn(first9: string): string {
  for (let digit = 0; digit <= 9; digit += 1) {
    const candidate = `${first9}${digit}`;
    if (luhn10(candidate)) {
      return candidate;
    }
  }
  throw new Error("no luhn digit");
}
