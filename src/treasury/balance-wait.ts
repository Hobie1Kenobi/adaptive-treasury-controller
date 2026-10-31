import type { Balance } from "../airwallex/types";
import { round2 } from "../money";

export function cashAvailable(balances: Balance[], currency: string): number {
  const rows = balances.filter(
    (row) => row.currency === currency && (row.account_type == null || row.account_type === "cash"),
  );
  return round2(rows.reduce((sum, row) => sum + (row.available_amount ?? 0), 0));
}

export async function waitForBalanceCredit(
  read: () => Promise<Balance[]>,
  currency: string,
  before: number,
  expectedDelta: number,
  options: {
    attempts?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Balance[]> {
  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const target = round2(before + expectedDelta);
  let latest: Balance[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await read();
    if (cashAvailable(latest, currency) + 0.001 >= target) return latest;
    if (attempt < attempts - 1) await sleep(intervalMs);
  }
  throw new Error(
    `Balance credit of ${expectedDelta} ${currency} was not visible after ${attempts} reads. Last available was ${cashAvailable(latest, currency)} ${currency}.`,
  );
}
