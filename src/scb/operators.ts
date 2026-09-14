/**
 * Conservative SCB variable-operator allowlist.
 *
 * `Innehaller` is evidenced in-repo (README, exampleJe payload tests). The rest
 * are Swedish SCB-style names documented by help examples / third-party clients
 * of sokpavar. Live `/help` is certificate-gated and was not re-read for Sprint B
 * — verify against `/help/exampleJe` and `/help/exampleAe` before treating the
 * extra names as exhaustive.
 */
export const SCB_OPERATOR_NAMES = [
  "Innehaller",
  "ArLikaMed",
  "BorjarPa",
  "Mellan",
  "FranOchMed",
  "TillOchMed",
  "Finns",
  "FinnsInte",
] as const;

export type ScbOperator = (typeof SCB_OPERATOR_NAMES)[number];

export type OperatorArity = 0 | 1 | 2;

export type ScbOperatorInfo = {
  name: ScbOperator;
  arity: OperatorArity;
  usesValue2: boolean;
  typicalKinds: string[];
  verifiedInRepo: boolean;
  meaning: string;
};

export const SCB_OPERATORS: ScbOperatorInfo[] = [
  {
    name: "Innehaller",
    arity: 1,
    usesValue2: false,
    typicalKinds: ["name", "text"],
    verifiedInRepo: true,
    meaning: "Delsträng (contains). Verifierad i exampleJe / README.",
  },
  {
    name: "ArLikaMed",
    arity: 1,
    usesValue2: false,
    typicalKinds: ["identity", "name", "text"],
    verifiedInRepo: false,
    meaning: "Exakt lika. Bekräfta mot /help/exampleJe.",
  },
  {
    name: "BorjarPa",
    arity: 1,
    usesValue2: false,
    typicalKinds: ["name", "text"],
    verifiedInRepo: false,
    meaning: "Prefix. Bekräfta mot /help/exampleJe.",
  },
  {
    name: "Mellan",
    arity: 2,
    usesValue2: true,
    typicalKinds: ["date", "numeric"],
    verifiedInRepo: false,
    meaning: "Intervall (Varde1 + Varde2). Bekräfta mot help.",
  },
  {
    name: "FranOchMed",
    arity: 1,
    usesValue2: false,
    typicalKinds: ["date", "numeric"],
    verifiedInRepo: false,
    meaning: "Nedre gräns. Bekräfta mot help.",
  },
  {
    name: "TillOchMed",
    arity: 1,
    usesValue2: false,
    typicalKinds: ["date", "numeric"],
    verifiedInRepo: false,
    meaning: "Övre gräns. Bekräfta mot help.",
  },
  {
    name: "Finns",
    arity: 0,
    usesValue2: false,
    typicalKinds: ["text"],
    verifiedInRepo: false,
    meaning: "Värde finns. Bekräfta mot help.",
  },
  {
    name: "FinnsInte",
    arity: 0,
    usesValue2: false,
    typicalKinds: ["text"],
    verifiedInRepo: false,
    meaning: "Värde saknas. Bekräfta mot help.",
  },
];

const OPERATOR_SET = new Set<string>(SCB_OPERATOR_NAMES);

export function isAllowedOperator(value: string): value is ScbOperator {
  return OPERATOR_SET.has(value);
}

export function operatorInfo(name: string): ScbOperatorInfo | undefined {
  return SCB_OPERATORS.find((item) => item.name === name);
}

export type OperatorIssue = {
  variable: string;
  operator: string;
  message: string;
};

export function validateVariableOperators(
  variables: Array<{ variable: string; operator: string; value?: string | undefined; value2?: string | undefined }>,
): OperatorIssue[] {
  const issues: OperatorIssue[] = [];
  for (const item of variables) {
    if (!isAllowedOperator(item.operator)) {
      issues.push({
        variable: item.variable,
        operator: item.operator,
        message: `Okänd operator "${item.operator}". Tillåtna: ${SCB_OPERATOR_NAMES.join(", ")}.`,
      });
      continue;
    }
    const info = operatorInfo(item.operator);
    if (!info) {
      continue;
    }
    const hasValue = item.value !== undefined && item.value !== "";
    const hasValue2 = item.value2 !== undefined && item.value2 !== "";
    if (info.arity === 0 && (hasValue || hasValue2)) {
      issues.push({
        variable: item.variable,
        operator: item.operator,
        message: `${item.operator} tar inget Varde1/Varde2.`,
      });
    }
    if (info.arity >= 1 && !hasValue) {
      issues.push({
        variable: item.variable,
        operator: item.operator,
        message: `${item.operator} kräver Varde1.`,
      });
    }
    if (info.arity === 2 && !hasValue2) {
      issues.push({
        variable: item.variable,
        operator: item.operator,
        message: `${item.operator} kräver Varde2 (Mellan).`,
      });
    }
  }
  return issues;
}

export function typicalOperatorsForVariableKind(kind: string): ScbOperator[] {
  switch (kind) {
    case "identity":
      return ["ArLikaMed"];
    case "date":
      return ["FranOchMed", "TillOchMed", "Mellan", "ArLikaMed"];
    case "name":
      return ["Innehaller", "BorjarPa", "ArLikaMed"];
    default:
      return ["Innehaller", "ArLikaMed"];
  }
}

export const OPERATORS_VERIFY_NOTE =
  "Operatorlistan är en konservativ allowlist. Innehaller är belagd i repot; övriga namn ska verifieras mot SCB /help/exampleJe och /help/exampleAe.";
