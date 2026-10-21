import { Firestore } from "@google-cloud/firestore";
import { CompanyCacheError, companyFromDocument, type CachedCompany } from "./directory.js";

export const COMPANY_PROJECT_ID = "bizmate-ai-specialist";
export const COMPANY_COLLECTION = "companies";

type ServiceAccount = {
  clientEmail: string;
  privateKey: string;
};

let firestore: Firestore | undefined;

/**
 * Load active company documents from the default Firestore database.
 * Credentials are the service-account JSON in `GCP_SA_JSON`. The raw JSON is never logged.
 */
export async function loadActiveCompanies(serviceAccountJson: string): Promise<CachedCompany[]> {
  const account = parseServiceAccount(serviceAccountJson);
  const db = clientFor(account);
  try {
    const snapshot = await db.collection(COMPANY_COLLECTION).where("active", "==", true).get();
    const companies: CachedCompany[] = [];
    snapshot.forEach((doc) => {
      const company = companyFromDocument(doc.id, doc.data() as Record<string, unknown>);
      if (company) {
        companies.push(company);
      }
    });
    return companies;
  } catch (error) {
    if (error instanceof CompanyCacheError) {
      throw error;
    }
    throw new CompanyCacheError(safeFirestoreMessage(error), "load_failed");
  }
}

export function parseServiceAccount(raw: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CompanyCacheError("GCP_SA_JSON is not valid JSON.", "load_failed");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CompanyCacheError("GCP_SA_JSON is not valid JSON.", "load_failed");
  }
  const record = parsed as Record<string, unknown>;
  const clientEmail = record.client_email;
  const privateKey = record.private_key;
  if (typeof clientEmail !== "string" || !clientEmail.includes("@")) {
    throw new CompanyCacheError("GCP_SA_JSON is missing client_email.", "load_failed");
  }
  if (typeof privateKey !== "string" || !privateKey.includes("PRIVATE KEY")) {
    throw new CompanyCacheError("GCP_SA_JSON is missing private_key.", "load_failed");
  }
  return { clientEmail, privateKey };
}

function clientFor(account: ServiceAccount): Firestore {
  firestore ??= new Firestore({
    projectId: COMPANY_PROJECT_ID,
    preferRest: true,
    credentials: {
      client_email: account.clientEmail,
      private_key: account.privateKey,
    },
  });
  return firestore;
}

function safeFirestoreMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Firestore request failed.";
  if (/private[_ ]key|BEGIN PRIVATE|client_email/iu.test(message)) {
    return "Firestore credentials were rejected.";
  }
  return message.slice(0, 180);
}
