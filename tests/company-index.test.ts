import { describe, expect, it } from "vitest";
import { companyFromDocument, createCompanyDirectory, organizationNumberKey } from "../src/companies/directory.js";
import { parseServiceAccount } from "../src/companies/firestore.js";
import { normalizeCompanyName } from "../src/companies/normalize.js";
import {
  indexCompany,
  NAME_MATCH_THRESHOLD,
  rankCompanies,
  scoreCompanyName,
  type CachedCompany,
} from "../src/companies/rank.js";

function company(partial: CachedCompany): CachedCompany {
  return partial;
}

describe("normalizeCompanyName", () => {
  it("folds Swedish letters and drops AB, aktiebolag, and punctuation", () => {
    expect(normalizeCompanyName("TORÉNS AB")).toBe("torens");
    expect(normalizeCompanyName("TREEAB Aktiebolag")).toBe("treeab");
    expect(normalizeCompanyName("Anders Westlunds Entreprenad AB")).toBe("anders westlunds entreprenad");
    expect(normalizeCompanyName("Skåne-Bygg, AB")).toBe("skane bygg");
    expect(normalizeCompanyName("  Peab.  ")).toBe("peab");
    expect(normalizeCompanyName(normalizeCompanyName("TORÉNS AB"))).toBe("torens");
  });

  it("keeps AB when it is part of the distinctive name", () => {
    expect(normalizeCompanyName("TREEAB")).toBe("treeab");
  });
});

describe("company name ranking", () => {
  const companies = [
    company({
      organizationNumber: "5560000001",
      name: "TREEAB",
      nameNormalized: "treeab",
      city: "Uppsala",
      sizeClass: "20-49 anställda",
      industry: "41200 Byggande av hus",
      status: "verksam",
    }),
    company({
      organizationNumber: "5560000002",
      name: "TORÉNS AB",
      nameNormalized: "torens",
      city: "Malmö",
      status: "verksam",
    }),
    company({
      organizationNumber: "5560000003",
      name: "Anders Westlunds Entreprenad AB",
      nameNormalized: "anders westlunds entreprenad",
      city: "Örebro",
      status: "verksam",
    }),
    company({
      organizationNumber: "5560000004",
      name: "Trelleborgs Bygg AB",
      nameNormalized: "trelleborgs bygg",
      status: "verksam",
    }),
    company({
      organizationNumber: "5560000005",
      name: "Volvo Lastvagnar AB",
      nameNormalized: "volvo lastvagnar",
      status: "verksam",
    }),
  ].map((item) => indexCompany(item));

  it("maps speech-to-text misses onto the right company", () => {
    expect(scoreCompanyName("Treab", "treeab")).toBeGreaterThan(NAME_MATCH_THRESHOLD);
    expect(scoreCompanyName("Torens", "torens")).toBe(1);
    expect(scoreCompanyName("Westlund", "anders westlunds entreprenad")).toBeGreaterThan(NAME_MATCH_THRESHOLD);

    const treab = rankCompanies(companies, "Treab");
    expect(treab.results[0]?.name).toBe("TREEAB");
    expect(treab.results.some((item) => item.name === "Volvo Lastvagnar AB")).toBe(false);

    const torens = rankCompanies(companies, "Torens");
    expect(torens.results[0]?.name).toBe("TORÉNS AB");

    const westlund = rankCompanies(companies, "Westlund");
    expect(westlund.results[0]?.name).toBe("Anders Westlunds Entreprenad AB");
  });

  it("does not treat an unrelated name as a hit", () => {
    const ranked = rankCompanies(companies, "Qzqzqzq Byggfirma");
    expect(ranked.bestScore).toBeLessThan(NAME_MATCH_THRESHOLD);
    expect(ranked.matched).toBe(0);
  });

  it("searches a few thousand companies in well under 300 ms", () => {
    const many = Array.from({ length: 7_200 }, (_, index) =>
      indexCompany({
        organizationNumber: String(5_560_000_000 + index),
        name: `Byggbolag ${index} AB`,
        nameNormalized: `byggbolag ${index}`,
        status: "verksam",
      }),
    );
    many[4_000] = indexCompany({
      organizationNumber: "5599999999",
      name: "TREEAB",
      nameNormalized: "treeab",
      city: "Uppsala",
      status: "verksam",
    });
    const started = performance.now();
    const ranked = rankCompanies(many, "Treab");
    const elapsed = performance.now() - started;
    console.log(`warm name search ${elapsed.toFixed(1)} ms over ${many.length} companies`);
    expect(elapsed).toBeLessThan(300);
    expect(ranked.results[0]?.organizationNumber).toBe("5599999999");
    expect(ranked.results.length).toBeLessThanOrEqual(5);
  });
});

describe("company documents", () => {
  it("maps a Firestore company onto the voice fields", () => {
    const company = companyFromDocument("5560747569", {
      name: "TREEAB",
      nameLower: "treeab",
      nameNormalized: "treeab",
      city: "Uppsala",
      municipality: "Uppsala",
      county: "Uppsala län",
      sni: ["41200"],
      sniGroup: "Byggande av hus",
      employeesClass: "5",
      turnoverClass: "10-20 mkr",
      phone: "018123456",
      email: "info@example.test",
      legalForm: "AB",
      active: true,
      source: "scb",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(company).toEqual({
      organizationNumber: "5560747569",
      name: "TREEAB",
      nameNormalized: "treeab",
      city: "Uppsala",
      sizeClass: "20-49 anställda",
      industry: "41200 Byggande av hus",
      status: "verksam",
    });
  });

  it("drops inactive documents and accepts a 12-digit organisation number", () => {
    expect(companyFromDocument("5560000001", { name: "Vilande AB", active: false })).toBeUndefined();
    expect(organizationNumberKey("165560747569")).toBe("5560747569");
    expect(organizationNumberKey("556074-7569")).toBe("5560747569");
  });
});

describe("company directory", () => {
  it("reuses a snapshot until the ttl and then reloads", async () => {
    let clock = 1_000;
    let loads = 0;
    const directory = createCompanyDirectory({
      load: async () => {
        loads += 1;
        return [
          company({
            organizationNumber: "5560000001",
            name: "TREEAB",
            nameNormalized: "treeab",
            status: "verksam",
          }),
        ];
      },
      now: () => clock,
      ttlMs: 1_000,
      loadBudgetMs: 50,
    });
    const first = await directory.searchByName("Treab");
    expect(first.kind).toBe("hit");
    expect(loads).toBe(1);
    clock += 500;
    await directory.searchByName("Treab");
    expect(loads).toBe(1);
    clock += 600;
    await directory.searchByName("Treab");
    expect(loads).toBe(2);
  });

  it("looks up an organisation number from the snapshot", async () => {
    const directory = createCompanyDirectory({
      load: async () => [
        company({
          organizationNumber: "5560747569",
          name: "TREEAB",
          nameNormalized: "treeab",
          status: "verksam",
        }),
      ],
    });
    const hit = await directory.findByOrganizationNumber("165560747569");
    expect(hit.kind).toBe("hit");
    if (hit.kind === "hit") {
      expect(hit.company.name).toBe("TREEAB");
    }
    const miss = await directory.findByOrganizationNumber("5599999999");
    expect(miss.kind).toBe("miss");
  });
});

describe("parseServiceAccount", () => {
  it("reads the service account without echoing a bad payload", () => {
    const account = parseServiceAccount(
      JSON.stringify({
        client_email: "cache@bizmate-ai-specialist.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
        project_id: "bizmate-ai-specialist",
      }),
    );
    expect(account.clientEmail).toBe("cache@bizmate-ai-specialist.iam.gserviceaccount.com");
    const secret = '{"private_key":"super-secret-key-material"';
    expect(() => parseServiceAccount(secret)).toThrow(/not valid JSON/);
    try {
      parseServiceAccount(secret);
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("super-secret-key-material");
    }
  });
});
