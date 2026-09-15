import type { CompileResult, CoverageEntry, IndustryCandidate, UnresolvedConstraint } from "./types.js";

export const QUERY_CHOOSE_CANDIDATE_LIMIT = 5;

export type QueryStatus = CompileResult["status"];

export function classifyQueryStatus(compiled: {
  ok: boolean;
  unresolved: UnresolvedConstraint[];
  coverage: CoverageEntry[];
}): QueryStatus {
  if (compiled.ok) {
    return "ok";
  }
  const industry = compiled.unresolved.find((item) => item.constraint === "industry");
  const otherUnresolved = compiled.unresolved.filter((item) => item.constraint !== "industry");
  const otherUnrepresentable = compiled.coverage.filter(
    (entry) => entry.constraint !== "industry" && entry.relation === "unrepresentable",
  );
  const candidates = industry?.candidates ?? [];
  if (candidates.length > 0 && otherUnresolved.length === 0 && otherUnrepresentable.length === 0) {
    return "choose";
  }
  return "impossible";
}

export function chooseCandidates(candidates: IndustryCandidate[], limit = QUERY_CHOOSE_CANDIDATE_LIMIT): IndustryCandidate[] {
  return candidates.slice(0, limit).map((candidate, index) => {
    const item: IndustryCandidate = {
      category: candidate.category,
      code: candidate.code,
      label: candidate.label,
    };
    if (candidate.score !== undefined) {
      item.score = candidate.score;
    }
    if (candidate.level !== undefined) {
      item.level = candidate.level;
    }
    if (candidate.parentCode !== undefined) {
      item.parentCode = candidate.parentCode;
    }
    item.why =
      candidate.score !== undefined
        ? `discovery-träff #${index + 1} (score ${candidate.score})`
        : `discovery-träff #${index + 1}`;
    return item;
  });
}

export function firstUnresolvedReason(
  unresolved: UnresolvedConstraint[],
  coverage: CoverageEntry[],
  fallback: string,
): string {
  return unresolved[0]?.reason ?? coverage.find((entry) => entry.relation === "unrepresentable")?.message ?? fallback;
}
