import { describe, expect, it } from "vitest";
import { companyFromDocument, createCompanyDirectory, organizationNumberKey } from "../src/companies/directory.js";
import { parseServiceAccount } from "../src/companies/firestore.js";
import { normalizeCompanyName } from "../src/companies/normalize.js";
import {
  buildSearchIndex,
  indexCompany,
  NAME_MATCH_THRESHOLD,
  PLAUSIBLE_THRESHOLD,
  rankCompanies,
  scoreCompanyName,
  wholeTokenScore,
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
    expect(normalizeCompanyName("Tre ab bygg")).toBe("treab bygg");
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

  it("matches spoken names, including a split AB and a trailing place", () => {
    const spoken = [
      company({
        organizationNumber: "5560000011",
        name: "TREEAB BYGG I ÖSTERSUND AB",
        nameNormalized: "treeab bygg i ostersund",
        city: "Östersund",
        status: "verksam",
      }),
      company({
        organizationNumber: "5560000012",
        name: "TORÉNS AB",
        nameNormalized: "torens",
        status: "verksam",
      }),
      company({
        organizationNumber: "5560000013",
        name: "TORÉNS ENTREPRENAD AB",
        nameNormalized: "torens entreprenad",
        status: "verksam",
      }),
      company({
        organizationNumber: "5560000014",
        name: "KENDRIL BYGG I STOCKHOLM AB",
        nameNormalized: "kendril bygg i stockholm",
        city: "Stockholm",
        status: "verksam",
      }),
      company({
        organizationNumber: "5560000004",
        name: "Trelleborgs Bygg AB",
        nameNormalized: "trelleborgs bygg",
        status: "verksam",
      }),
    ].map((item) => indexCompany(item));

    expect(rankCompanies(spoken, "Treab bygg")).toMatchObject({
      lowConfidence: false,
      results: [expect.objectContaining({ name: "TREEAB BYGG I ÖSTERSUND AB" })],
    });
    expect(rankCompanies(spoken, "Tre ab bygg").results[0]?.name).toBe("TREEAB BYGG I ÖSTERSUND AB");
    expect(rankCompanies(spoken, "Torens").results[0]?.name).toBe("TORÉNS AB");
    expect(rankCompanies(spoken, "Toréns entreprenad östersund").results[0]?.name).toBe(
      "TORÉNS ENTREPRENAD AB",
    );
    expect(rankCompanies(spoken, "Kendril").results[0]?.name).toBe("KENDRIL BYGG I STOCKHOLM AB");
    expect(rankCompanies(spoken, "Treab bygg").bestScore).toBeGreaterThanOrEqual(NAME_MATCH_THRESHOLD);
  });

  it("returns a weak candidate instead of a miss when the score is still plausible", () => {
    const ranked = rankCompanies(
      [
        indexCompany({
          organizationNumber: "5560000099",
          name: "KENDRIL AB",
          nameNormalized: "kendril",
          status: "verksam",
        }),
      ],
      "Kandrel",
    );
    expect(ranked.lowConfidence).toBe(true);
    expect(ranked.bestScore).toBeGreaterThanOrEqual(PLAUSIBLE_THRESHOLD);
    expect(ranked.bestScore).toBeLessThan(NAME_MATCH_THRESHOLD);
    expect(ranked.results[0]?.name).toBe("KENDRIL AB");
  });

  it("does not treat a letter sequence inside a longer word as a name", () => {
    expect(wholeTokenScore("treab", "treeab")).toBeGreaterThanOrEqual(NAME_MATCH_THRESHOLD);
    expect(wholeTokenScore("treab", "petrebygg")).toBe(0);
    expect(wholeTokenScore("treab", "istrabygg")).toBe(0);
    expect(wholeTokenScore("torens", "rormontoren")).toBe(0);
    expect(wholeTokenScore("torens", "torens")).toBe(1);
  });

  it("does not treat an unrelated name as a hit", () => {
    const ranked = rankCompanies(companies, "Qzqzqzq Byggfirma");
    expect(ranked.bestScore).toBeLessThan(PLAUSIBLE_THRESHOLD);
    expect(ranked.matched).toBe(0);
    expect(ranked.lowConfidence).toBe(false);
  });

  it("lets a rare whole token beat generic names in a large construction corpus", () => {
    const corpus = realisticConstructionCorpus();
    const built = performance.now();
    const index = buildSearchIndex(corpus);
    const buildMs = performance.now() - built;
    const started = performance.now();
    const treab = rankCompanies(index, "treab bygg");
    const treabMs = performance.now() - started;
    const split = rankCompanies(index, "Tre ab bygg");
    const torens = rankCompanies(index, "torens");
    const again = performance.now();
    rankCompanies(index, "treab bygg");
    const secondMs = performance.now() - again;
    console.log(
      `index ${buildMs.toFixed(1)} ms, warm search ${treabMs.toFixed(1)} ms, second ${secondMs.toFixed(1)} ms over ${corpus.length} companies`,
    );
    expect(treabMs).toBeLessThan(300);
    expect(secondMs).toBeLessThan(300);
    expect(treab.lowConfidence).toBe(false);
    expect(treab.results[0]).toMatchObject({
      organizationNumber: "5566086376",
      name: "TREEAB BYGG I ÖSTERSUND AB",
    });
    expect(treab.results.some((item) => item.name === "Istra Bygg AB" || item.name === "PeTre Bygg AB")).toBe(false);
    expect(split.results[0]?.organizationNumber).toBe("5566086376");
    expect(torens.results[0]?.name).toBe("TORÉNS AB");
    expect(torens.results.some((item) => item.name.startsWith("Rörmontören"))).toBe(false);
  });
});

function realisticConstructionCorpus(): CachedCompany[] {
  const companies: CachedCompany[] = [];
  const push = (organizationNumber: string, name: string, nameNormalized: string) => {
    companies.push({ organizationNumber, name, nameNormalized, status: "verksam" });
  };
  for (let i = 0; i < 3_500; i += 1) {
    push(String(5_500_000_000 + i), `Firma${i} Bygg AB`, `firma${i} bygg`);
  }
  for (let i = 0; i < 800; i += 1) {
    push(String(5_600_000_000 + i), `Rörmontören ${i} AB`, `rormontoren ${i}`);
  }
  for (let i = 0; i < 200; i += 1) {
    push(String(5_700_000_000 + i), `Elbolag ${i} AB`, `elbolag ${i} el`);
  }
  for (let i = 0; i < 200; i += 1) {
    push(String(5_710_000_000 + i), `VVS Partner ${i} AB`, `vvs partner ${i}`);
  }
  for (let i = 0; i < 200; i += 1) {
    push(String(5_720_000_000 + i), `Markarbete ${i} AB`, `markarbete ${i} mark`);
  }
  for (let i = 0; i < 200; i += 1) {
    push(String(5_730_000_000 + i), `Entreprenad ${i} Östersund AB`, `entreprenad ${i} ostersund`);
  }
  push("5566086376", "TREEAB BYGG I ÖSTERSUND AB", "treeab bygg i ostersund");
  push("5561000001", "Istra Bygg AB", "istra bygg");
  push("5561000002", "PeTre Bygg AB", "petre bygg");
  push("5561000003", "PeTreBygg AB", "petrebygg");
  push("5561000004", "Rörmontören Syd AB", "rormontoren syd");
  push("5561000005", "RörmontörenSyd AB", "rormontorensyd");
  push("5561000006", "TORÉNS AB", "torens");
  push("5561000007", "TORÉNS ENTREPRENAD AB", "torens entreprenad");
  return companies;
}

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
  it("waits for the first index load instead of giving up", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const directory = createCompanyDirectory({
      load: async () => {
        await gate;
        return [
          company({
            organizationNumber: "5566086376",
            name: "TREEAB BYGG I ÖSTERSUND AB",
            nameNormalized: "treeab bygg i ostersund",
            status: "verksam",
          }),
        ];
      },
    });
    let settled = false;
    const pending = directory.searchByName("Treab bygg").then((outcome) => {
      settled = true;
      return outcome;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    const outcome = await pending;
    expect(outcome.kind).toBe("hit");
    if (outcome.kind === "hit") {
      expect(outcome.results[0]?.organizationNumber).toBe("5566086376");
      expect(outcome.lowConfidence).toBe(false);
    }
  });

  it("reuses a snapshot until the ttl and refreshes without blocking", async () => {
    let clock = 1_000;
    let loads = 0;
    let releaseRefresh: () => void = () => {};
    const directory = createCompanyDirectory({
      load: async () => {
        loads += 1;
        if (loads > 1) {
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          });
        }
        return [
          company({
            organizationNumber: "5560000001",
            name: loads === 1 ? "TREEAB" : "TREEAB NY",
            nameNormalized: "treeab",
            status: "verksam",
          }),
        ];
      },
      now: () => clock,
      ttlMs: 1_000,
    });
    const first = await directory.searchByName("Treab");
    expect(first.kind).toBe("hit");
    if (first.kind === "hit") {
      expect(first.results[0]?.name).toBe("TREEAB");
    }
    expect(loads).toBe(1);
    clock += 500;
    await directory.searchByName("Treab");
    expect(loads).toBe(1);
    clock += 600;
    const during = await directory.searchByName("Treab");
    expect(loads).toBe(2);
    expect(during.kind).toBe("hit");
    if (during.kind === "hit") {
      expect(during.results[0]?.name).toBe("TREEAB");
    }
    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const refreshed = await directory.searchByName("Treab");
    expect(loads).toBe(2);
    expect(refreshed.kind).toBe("hit");
    if (refreshed.kind === "hit") {
      expect(refreshed.results[0]?.name).toBe("TREEAB NY");
    }
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
