import { resolveMode } from "../env";
import type { AirwallexClient } from "./types";
import { HttpAirwallexClient } from "./http-client";
import { MockAirwallexClient } from "./mock-client";

export function createClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): AirwallexClient {
  const mode = resolveMode(env);
  if (mode === "mock") return new MockAirwallexClient();
  return new HttpAirwallexClient(env, fetchImpl);
}

export function indicativeUsdPerUnit(rate: {
  rate?: number;
  buy_amount?: number;
  sell_amount?: number;
  rate_details?: Array<{ level?: string; rate?: number }>;
}): number {
  const client = rate.rate_details?.find((item) => item.level === "CLIENT") ?? rate.rate_details?.[0];
  if (client?.rate && client.rate > 0 && client.rate < 1000) return client.rate;
  if (rate.rate && rate.rate > 0 && rate.rate < 1000) return rate.rate;
  if (rate.buy_amount && rate.sell_amount && rate.buy_amount > 0) {
    return rate.sell_amount / rate.buy_amount;
  }
  throw new Error("FX rate response did not include a usable client rate");
}
