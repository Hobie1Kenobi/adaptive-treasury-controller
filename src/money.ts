export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function money(amount: number, currency: string): string {
  return `${currency} ${round2(amount).toFixed(2)}`;
}

export function amountString(amount: number): string {
  return round2(amount).toFixed(2);
}

/** Airwallex timestamps often use a +0000 offset, which Date.parse rejects. */
export function parseAirwallexTime(value: string): number {
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) {
    throw new Error(`Could not parse Airwallex timestamp: ${value}`);
  }
  return ms;
}
