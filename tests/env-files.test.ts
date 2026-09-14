import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFiles } from "../src/config/env.js";

const TRACKED = ["SCB_API_ID", "SCB_FROM_EXAMPLE", "SCB_FROM_DOTENV", "SCB_ALREADY"] as const;

const snapshot: Record<string, string | undefined> = {};

function rememberEnv(): void {
  for (const key of TRACKED) {
    snapshot[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of TRACKED) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("loadEnvFiles", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("loads .env only and never reads .env.example", () => {
    rememberEnv();
    const dir = mkdtempSync(join(tmpdir(), "scb-env-"));
    writeFileSync(join(dir, ".env.example"), "SCB_API_ID=from-example\nSCB_FROM_EXAMPLE=1\n");
    writeFileSync(join(dir, ".env"), "SCB_API_ID=from-env\nSCB_FROM_DOTENV=1\n");
    delete process.env.SCB_API_ID;
    delete process.env.SCB_FROM_EXAMPLE;
    delete process.env.SCB_FROM_DOTENV;

    loadEnvFiles(dir);

    expect(process.env.SCB_API_ID).toBe("from-env");
    expect(process.env.SCB_FROM_DOTENV).toBe("1");
    expect(process.env.SCB_FROM_EXAMPLE).toBeUndefined();
  });

  it("does not overwrite keys already set in process.env", () => {
    rememberEnv();
    const dir = mkdtempSync(join(tmpdir(), "scb-env-"));
    writeFileSync(join(dir, ".env"), "SCB_API_ID=from-env\nSCB_ALREADY=from-file\n");
    process.env.SCB_API_ID = "already-set";
    delete process.env.SCB_ALREADY;

    loadEnvFiles(dir);

    expect(process.env.SCB_API_ID).toBe("already-set");
    expect(process.env.SCB_ALREADY).toBe("from-file");
  });

  it("does not apply .env.example placeholders when .env is missing", () => {
    rememberEnv();
    const dir = mkdtempSync(join(tmpdir(), "scb-env-"));
    writeFileSync(join(dir, ".env.example"), "SCB_API_ID=API-ID\nSCB_FROM_EXAMPLE=1\n");
    delete process.env.SCB_API_ID;
    delete process.env.SCB_FROM_EXAMPLE;

    loadEnvFiles(dir);

    expect(process.env.SCB_API_ID).toBeUndefined();
    expect(process.env.SCB_FROM_EXAMPLE).toBeUndefined();
  });
});
