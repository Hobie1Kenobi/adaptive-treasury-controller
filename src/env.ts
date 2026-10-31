import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type TreasuryMode = "mock" | "sandbox";

export function loadDotEnv(file = path.join(process.cwd(), ".env")): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function resolveMode(env: NodeJS.ProcessEnv = process.env): TreasuryMode {
  const explicit = (env.TREASURY_MODE ?? "auto").trim().toLowerCase();
  if (explicit === "mock") return "mock";
  if (explicit === "sandbox") {
    if (!env.AIRWALLEX_CLIENT_ID || !env.AIRWALLEX_API_KEY) {
      throw new Error(
        "TREASURY_MODE=sandbox requires AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY. Sign up at https://sandbox.airwallex.com and create a key under Account → Developer → API keys.",
      );
    }
    return "sandbox";
  }
  if (explicit !== "auto") {
    throw new Error(`Unknown TREASURY_MODE "${explicit}". Use auto, mock, or sandbox.`);
  }
  if (env.AIRWALLEX_CLIENT_ID && env.AIRWALLEX_API_KEY) return "sandbox";
  return "mock";
}

/** USD opening balance the policy treats as the operating book. `off` uses the live wallet. */
export function resolveOperatingCap(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env.TREASURY_OPERATING_CAP ?? "15500").trim().toLowerCase();
  if (raw === "off" || raw === "live" || raw === "none") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`TREASURY_OPERATING_CAP must be a positive amount or "off". Received "${raw}".`);
  }
  return value;
}

export function apiRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.AIRWALLEX_BASE_URL ?? "https://api.sandbox.airwallex.com").replace(/\/$/, "");
  return raw.endsWith("/api/v1") ? raw : `${raw}/api/v1`;
}
