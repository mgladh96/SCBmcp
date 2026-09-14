export const SCB_ENDPOINTS = {
  je: {
    koptakategorier: "/api/je/koptakategorier",
    kategoriermedkodtabeller: "/api/je/kategoriermedkodtabeller",
    kodtabell: "/api/je/kodtabell",
    koptavariabler: "/api/je/koptavariabler",
    variabler: "/api/je/variabler",
    raknaforetag: "/api/je/raknaforetag",
    hamtaforetag: "/api/je/hamtaforetag",
  },
  ae: {
    koptakategorier: "/api/ae/koptakategorier",
    kategoriermedkodtabeller: "/api/ae/kategoriermedkodtabeller",
    kodtabell: "/api/ae/kodtabell",
    koptavariabler: "/api/ae/koptavariabler",
    variabler: "/api/ae/variabler",
    raknaarbetsstallen: "/api/ae/raknaarbetsstallen",
    hamtaarbetsstallen: "/api/ae/hamtaarbetsstallen",
  },
} as const;

export type ScbLayout = "je" | "ae";

export function endpointsFor(layout: ScbLayout) {
  return SCB_ENDPOINTS[layout];
}

export function countPath(layout: ScbLayout): string {
  return layout === "je" ? SCB_ENDPOINTS.je.raknaforetag : SCB_ENDPOINTS.ae.raknaarbetsstallen;
}

export function searchPath(layout: ScbLayout): string {
  return layout === "je" ? SCB_ENDPOINTS.je.hamtaforetag : SCB_ENDPOINTS.ae.hamtaarbetsstallen;
}
