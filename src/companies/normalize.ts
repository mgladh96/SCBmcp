const LEGAL_FORM = new Set(["ab", "aktiebolag", "aktiebolaget"]);

/**
 * Same shape as Firestore `nameNormalized`: lower case, åäö/é folded,
 * punctuation removed, and a trailing AB / aktiebolag dropped.
 * A short word split before "ab" in the middle ("Tre ab bygg") is joined
 * back, because that "ab" is part of the name rather than the legal form.
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
  const tokens = folded.split(/\s+/u);
  while (tokens.length > 1 && LEGAL_FORM.has(tokens[tokens.length - 1] ?? "")) {
    tokens.pop();
  }
  if (tokens[0] === "ab" && tokens.length > 1) {
    tokens.shift();
  }
  const joined: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1];
    if (
      next === "ab" &&
      token.length >= 2 &&
      token.length <= 4 &&
      index + 2 < tokens.length
    ) {
      joined.push(`${token}ab`);
      index += 1;
      continue;
    }
    if (token) {
      joined.push(token);
    }
  }
  return joined.join(" ");
}
