import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filterHintsFor, layoutHint, type QuestionClass } from "../../src/domain/catalog.js";
import { normalizeCfarNr, normalizePeOrgNr } from "../../src/scb/identity.js";
import { searchCodeTables } from "../../src/scb/code-lookup.js";
import type { ObjectType } from "../../src/scb/types.js";

/**
 * Offline eval runner (no LLM). Fixtures live in fixtures.json.
 * Extend: add an object with id, question, expectedObjectType, expectedCategories,
 * answerable, notes; optional questionClass, lookup, identity, layoutTrap.
 */
const FIXTURES_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures.json");

type EvalFixture = {
  id: string;
  question: string;
  expectedObjectType: "company" | "workplace" | "both" | "none";
  expectedCategories: string[];
  expectedVariables?: string[];
  questionClass?: QuestionClass;
  answerable: boolean;
  notes: string;
  lookup?: {
    query: string;
    objectType: ObjectType;
    expectedCategory: string;
    expectedCode: string;
  };
  identity?: {
    input: string;
    kind: "peOrgNr" | "cfarNr";
    expected?: string;
    invalid?: boolean;
  };
  layoutTrap?: {
    unknownName: string;
    objectType: ObjectType;
    hintIncludes: string;
  };
};

const MOCK_TABLES: Array<{ category: string; raw: unknown }> = [
  {
    category: "Län",
    raw: { Koder: [{ Kod: "21", Text: "Gävleborgs län" }, { Kod: "01", Text: "Stockholms län" }] },
  },
  {
    category: "Företagsstatus",
    raw: { Koder: [{ Kod: "1", Text: "verksam" }, { Kod: "0", Text: "aldrig verksam" }] },
  },
  {
    category: "Storleksklass Anställda",
    raw: { Koder: [{ Kod: "4", Text: "10-19 anställda" }, { Kod: "5", Text: "20-49 anställda" }] },
  },
  {
    category: "Bransch",
    raw: {
      Koder: [
        { Kod: "F", Text: "Byggverksamhet" },
        { Kod: "41", Text: "Byggande av hus" },
        { Kod: "62010", Text: "Dataprogrammering" },
      ],
    },
  },
];

const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as EvalFixture[];

describe("offline eval fixtures", () => {
  it("has 20–40 Swedish questions with notes", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    expect(fixtures.length).toBeLessThanOrEqual(40);
    const ids = new Set(fixtures.map((item) => item.id));
    expect(ids.size).toBe(fixtures.length);
    for (const fixture of fixtures) {
      expect(fixture.question.length).toBeGreaterThan(5);
      expect(fixture.notes.length).toBeGreaterThan(10);
    }
  });

  it.each(fixtures)("$id $question", (fixture) => {
    if (fixture.questionClass) {
      const objectType =
        fixture.expectedObjectType === "company" || fixture.expectedObjectType === "workplace"
          ? fixture.expectedObjectType
          : undefined;
      const hints = filterHintsFor(objectType, fixture.questionClass);
      expect(hints.length).toBeGreaterThan(0);
      const hint = hints[0];
      if (fixture.expectedObjectType === "company" || fixture.expectedObjectType === "workplace") {
        expect(hint?.objectType === fixture.expectedObjectType || hint?.objectType === "both").toBe(true);
      }
      if (fixture.expectedCategories.length > 0) {
        const recommended = hint?.recommendedCategories ?? [];
        const overlap = fixture.expectedCategories.some((name) => recommended.includes(name));
        expect(overlap, `${fixture.id} categories ${fixture.expectedCategories.join(",")} vs ${recommended.join(",")}`).toBe(
          true,
        );
      }
      if (fixture.expectedVariables && fixture.expectedVariables.length > 0) {
        const recommended = hint?.recommendedVariables ?? [];
        const overlap = fixture.expectedVariables.some((name) => recommended.includes(name));
        expect(overlap, `${fixture.id} variables`).toBe(true);
      }
    }

    if (fixture.lookup) {
      const result = searchCodeTables(fixture.lookup.objectType, fixture.lookup.query, MOCK_TABLES, 25);
      expect(result.matches[0]?.category).toBe(fixture.lookup.expectedCategory);
      expect(result.matches[0]?.code).toBe(fixture.lookup.expectedCode);
    }

    if (fixture.identity) {
      const result =
        fixture.identity.kind === "cfarNr"
          ? normalizeCfarNr(fixture.identity.input)
          : normalizePeOrgNr(fixture.identity.input);
      if (fixture.identity.invalid) {
        expect(result.ok).toBe(false);
      } else {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(fixture.identity.expected);
        }
      }
    }

    if (fixture.layoutTrap) {
      const hint = layoutHint(fixture.layoutTrap.unknownName, fixture.layoutTrap.objectType);
      expect(hint).toMatch(new RegExp(fixture.layoutTrap.hintIncludes, "i"));
    }

    if (!fixture.answerable) {
      expect(fixture.expectedObjectType === "none" || fixture.identity?.invalid === true).toBe(true);
    }
  });
});
