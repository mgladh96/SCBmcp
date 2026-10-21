const LEGAL_FORM = new Set(["ab", "aktiebolag", "aktiebolaget"]);

/**
 * Same shape as Firestore `nameNormalized`: lower case, åäö/é folded,
 * punctuation removed, and a trailing AB / aktiebolag dropped.
 */
export function normalizeCompanyName(value: string): string {
  const folded = value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
  if (!folded) {
    return "";
  }
  const tokens = folded.split(/\s+/u).filter((token) => !LEGAL_FORM.has(token));
  return tokens.join(" ");
}
