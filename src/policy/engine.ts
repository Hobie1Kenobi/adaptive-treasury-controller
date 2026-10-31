import { money, round2 } from "../money";
import type { Obligation } from "../scenario/seed";

export const POLICY = {
  reserveFloorUsd: 8000,
  openingUsdTarget: 15500,
  recalcDepositUsd: 2500,
  highConfidence: 0.88,
  lowConfidence: 0.42,
  confidenceThreshold: 0.75,
  autonomousConversionUsd: { high: 4000, low: 1000 },
  swiftFeeEur: 12.85,
} as const;

export const MOCK_USD_PER_UNIT: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
};

export type TreasuryAction = "fund" | "convert" | "defer" | "escalate";

export interface PolicyDecision {
  obligationId: string;
  payee: string;
  action: TreasuryAction;
  reasonCode: string;
  explanation: string;
  explanationSource: "policy" | "model";
  needsApproval: boolean;
  usdCost: number;
  fee: number;
  buyAmount: number;
  buyCurrency: string;
  sellAmount: number;
  sellCurrency: "USD";
  affected: boolean;
}

export interface PolicySnapshot {
  reserveFloorUsd: number;
  usdAvailable: number;
  headroomUsd: number;
  confidence: number;
  autonomousCapUsd: number;
  highCapUsd: number;
  swiftFeeEur: number;
  usdPerUnit: Record<string, number>;
  canSettleAll: boolean;
  totalUsdCost: number;
}

const CONFLICTING_EMAIL =
  /will not remit|next month|do not treat that receipt as committed/i;

export function confidenceFromEmail(emailBody: string | null): {
  confidence: number;
  reasonCode: string;
} {
  if (emailBody && CONFLICTING_EMAIL.test(emailBody)) {
    return {
      confidence: POLICY.lowConfidence,
      reasonCode: "customer_email_contradicts_forecast",
    };
  }
  return { confidence: POLICY.highConfidence, reasonCode: "forecast_supported" };
}

export function autonomousCapUsd(confidence: number): number {
  return confidence >= POLICY.confidenceThreshold
    ? POLICY.autonomousConversionUsd.high
    : POLICY.autonomousConversionUsd.low;
}

export function payoutFunding(obligation: Obligation): { fee: number; buyAmount: number } {
  const fee =
    obligation.transferMethod === "SWIFT" && obligation.currency === "EUR" ? POLICY.swiftFeeEur : 0;
  return { fee, buyAmount: round2(obligation.amount + fee) };
}

export function usdCost(obligation: Obligation, usdPerUnit: Record<string, number>): number {
  const { buyAmount } = payoutFunding(obligation);
  const rate = usdPerUnit[obligation.currency];
  if (!rate || rate <= 0) {
    throw new Error(`No USD rate for ${obligation.currency}`);
  }
  return round2(buyAmount * rate);
}

export function withinApprovalDrift(approvedSell: number, quotedSell: number): boolean {
  const drift = Math.abs(quotedSell - approvedSell);
  return drift <= Math.max(25, round2(approvedSell * 0.02));
}

export function buildPlan(input: {
  obligations: Obligation[];
  usdAvailable: number;
  balances: Record<string, number>;
  usdPerUnit: Record<string, number>;
  confidence: number;
}): { decisions: PolicyDecision[]; snapshot: PolicySnapshot } {
  const costs = new Map(input.obligations.map((item) => [item.id, usdCost(item, input.usdPerUnit)]));
  const totalUsdCost = round2([...costs.values()].reduce((sum, cost) => sum + cost, 0));
  const headroomUsd = round2(input.usdAvailable - POLICY.reserveFloorUsd);
  const canSettleAll = totalUsdCost <= headroomUsd + 0.001;
  const cap = autonomousCapUsd(input.confidence);

  let forcedDeferId: string | null = null;
  if (!canSettleAll) {
    const optional = input.obligations.filter((item) => !item.critical);
    optional.sort((a, b) => (costs.get(a.id) ?? 0) - (costs.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    forcedDeferId = optional[0]?.id ?? null;
  }

  const ordered = [...input.obligations].sort((a, b) => {
    if (a.critical !== b.critical) return a.critical ? -1 : 1;
    if (a.dueInHours !== b.dueInHours) return a.dueInHours - b.dueInHours;
    return (costs.get(b.id) ?? 0) - (costs.get(a.id) ?? 0);
  });

  let headroom = headroomUsd;
  const decisions: PolicyDecision[] = [];

  for (const obligation of ordered) {
    const cost = costs.get(obligation.id) ?? 0;
    const funding = payoutFunding(obligation);
    const held = input.balances[obligation.currency] ?? 0;
    const needsConvert = held + 0.001 < funding.buyAmount;
    const base = {
      obligationId: obligation.id,
      payee: obligation.payee,
      usdCost: cost,
      fee: funding.fee,
      buyAmount: funding.buyAmount,
      buyCurrency: obligation.currency,
      sellAmount: cost,
      sellCurrency: "USD" as const,
      affected: false,
      explanationSource: "policy" as const,
    };

    if (obligation.id === forcedDeferId) {
      decisions.push({
        ...base,
        action: "defer",
        reasonCode: "defer_cheapest",
        needsApproval: false,
        explanation: `${obligation.payee} is the cheapest non-critical obligation (${money(cost, "USD")} equivalent, due in ${obligation.dueInHours}h). The book costs ${money(totalUsdCost, "USD")} and only ${money(headroomUsd, "USD")} sits above the ${money(POLICY.reserveFloorUsd, "USD")} reserve floor, so this one is deferred.`,
      });
      continue;
    }

    if (cost <= headroom + 0.001) {
      if (needsConvert && cost > POLICY.autonomousConversionUsd.high) {
        decisions.push({
          ...base,
          action: "escalate",
          reasonCode: "escalate_above_ceiling",
          needsApproval: false,
          explanation: `${obligation.payee} fits the cash number but the ${money(cost, "USD")} conversion is above the ${money(POLICY.autonomousConversionUsd.high, "USD")} autonomous ceiling. That is a policy exception, not an approval.`,
        });
        continue;
      }
      headroom = round2(headroom - cost);
      if (!needsConvert) {
        decisions.push({
          ...base,
          action: "fund",
          reasonCode: obligation.critical ? "fund_critical" : "fund_within_floor",
          needsApproval: false,
          explanation: obligation.critical
            ? `${obligation.payee} is critical and due in ${obligation.dueInHours}h. Paying ${money(obligation.amount, obligation.currency)} from the ${obligation.currency} balance keeps available cash at or above the ${money(POLICY.reserveFloorUsd, "USD")} floor.`
            : `${obligation.payee} (${money(obligation.amount, obligation.currency)}, due in ${obligation.dueInHours}h) fits in the remaining headroom without a conversion, so it is funded.`,
        });
        continue;
      }
      const needsApproval = cost > cap;
      const approvalSentence = needsApproval
        ? ` Forecast confidence is ${input.confidence.toFixed(2)}, below ${POLICY.confidenceThreshold.toFixed(2)}, so the autonomous cap is ${money(cap, "USD")}. This conversion needs a person.`
        : ` Forecast confidence is ${input.confidence.toFixed(2)}, so the agent may convert up to ${money(cap, "USD")} without a person.`;
      const feeSentence =
        funding.fee > 0
          ? ` Buy ${money(funding.buyAmount, obligation.currency)} so the ${money(obligation.amount, obligation.currency)} invoice plus the flat ${money(funding.fee, obligation.currency)} SWIFT fee are both covered.`
          : ` Buy ${money(funding.buyAmount, obligation.currency)}. Local payouts have no fee.`;
      decisions.push({
        ...base,
        action: "convert",
        reasonCode: "convert_within_floor",
        needsApproval,
        explanation: `${obligation.payee} is due in ${obligation.dueInHours}h and the ${obligation.currency} balance does not cover it. The minimum USD sell is ${money(cost, "USD")}.${feeSentence}${approvalSentence}`,
      });
      continue;
    }

    if (obligation.critical || cost > POLICY.autonomousConversionUsd.high) {
      decisions.push({
        ...base,
        action: "escalate",
        reasonCode: "escalate_reserve_floor",
        needsApproval: false,
        explanation: `${obligation.payee} costs ${money(cost, "USD")} equivalent and the remaining headroom is ${money(headroom, "USD")} under the ${money(POLICY.reserveFloorUsd, "USD")} floor. It is escalated, not silently deferred.`,
      });
      continue;
    }

    decisions.push({
      ...base,
      action: "defer",
      reasonCode: "defer_reserve_floor",
      needsApproval: false,
      explanation: `${obligation.payee} costs ${money(cost, "USD")} and only ${money(headroom, "USD")} of headroom remains above the ${money(POLICY.reserveFloorUsd, "USD")} floor. Deferred until cash moves.`,
    });
  }

  const byId = new Map(decisions.map((item) => [item.obligationId, item]));
  return {
    decisions: input.obligations.map((item) => byId.get(item.id)!),
    snapshot: {
      reserveFloorUsd: POLICY.reserveFloorUsd,
      usdAvailable: round2(input.usdAvailable),
      headroomUsd,
      confidence: input.confidence,
      autonomousCapUsd: cap,
      highCapUsd: POLICY.autonomousConversionUsd.high,
      swiftFeeEur: POLICY.swiftFeeEur,
      usdPerUnit: { ...input.usdPerUnit },
      canSettleAll,
      totalUsdCost,
    },
  };
}

export function markAffected(
  previous: PolicyDecision[] | null,
  next: PolicyDecision[],
): PolicyDecision[] {
  if (!previous) return next.map((item) => ({ ...item, affected: false }));
  const prior = new Map(previous.map((item) => [item.obligationId, item]));
  return next.map((item) => {
    const old = prior.get(item.obligationId);
    const affected =
      !old ||
      old.action !== item.action ||
      old.needsApproval !== item.needsApproval ||
      old.usdCost !== item.usdCost;
    return { ...item, affected };
  });
}

export function applyExplanations(
  decisions: PolicyDecision[],
  proposal: Array<{ obligationId: string; action: TreasuryAction; explanation: string }> | null,
): { decisions: PolicyDecision[]; overrides: string[] } {
  if (!proposal) return { decisions, overrides: [] };
  const overrides: string[] = [];
  const next = decisions.map((decision) => {
    const suggested = proposal.find((item) => item.obligationId === decision.obligationId);
    if (!suggested) return decision;
    if (suggested.action !== decision.action) {
      overrides.push(
        `${decision.obligationId}: model proposed ${suggested.action}, policy kept ${decision.action}`,
      );
      return decision;
    }
    if (!suggested.explanation.trim()) return decision;
    return { ...decision, explanation: suggested.explanation.trim(), explanationSource: "model" as const };
  });
  return { decisions: next, overrides };
}
