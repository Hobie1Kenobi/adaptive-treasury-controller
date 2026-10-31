import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveMode } from "../src/env";
import {
  MOCK_USD_PER_UNIT,
  POLICY,
  applyExplanations,
  autonomousCapUsd,
  buildPlan,
  confidenceFromEmail,
  markAffected,
  resolveSwiftFee,
  usdCost,
  withinApprovalDrift,
} from "../src/policy/engine";
import { round2 } from "../src/money";
import { parseProposal } from "../src/planner/planner";
import { CONFLICTING_EMAIL, OBLIGATIONS } from "../src/scenario/seed";

const balances = { USD: POLICY.openingUsdTarget, EUR: 0, GBP: 0 };

function planAt(confidence: number, usdAvailable: number = POLICY.openingUsdTarget) {
  return buildPlan({
    obligations: OBLIGATIONS,
    usdAvailable,
    balances: { ...balances, USD: usdAvailable },
    usdPerUnit: MOCK_USD_PER_UNIT,
    confidence,
  });
}

function action(confidence: number, id: string, usdAvailable?: number) {
  const decision = planAt(confidence, usdAvailable).decisions.find((item) => item.obligationId === id);
  assert.ok(decision, id);
  return decision;
}

describe("policy engine", () => {
  it("prices the EUR SWIFT payout with the flat fee", () => {
    const eur = OBLIGATIONS.find((item) => item.id === "INV-EUR-220");
    assert.ok(eur);
    const fee = resolveSwiftFee();
    assert.equal(usdCost(eur, MOCK_USD_PER_UNIT), round2((eur.amount + fee.total) * MOCK_USD_PER_UNIT.EUR));
    assert.equal(fee.base, 13.48);
    assert.ok(fee.total > fee.base);
  });

  it("funds the critical invoice, converts the time-sensitive supplier, defers the cheapest, and escalates the floor breach", () => {
    assert.equal(action(POLICY.highConfidence, "INV-SHIP-1042").action, "fund");
    assert.equal(action(POLICY.highConfidence, "INV-SHIP-1042").reasonCode, "fund_critical");
    assert.equal(action(POLICY.highConfidence, "INV-EUR-220").action, "convert");
    assert.equal(action(POLICY.highConfidence, "INV-EUR-220").needsApproval, false);
    assert.equal(action(POLICY.highConfidence, "INV-GBP-088").action, "defer");
    assert.equal(action(POLICY.highConfidence, "INV-GBP-088").reasonCode, "defer_cheapest");
    assert.equal(action(POLICY.highConfidence, "INV-USD-317").action, "defer");
    assert.equal(action(POLICY.highConfidence, "INV-USD-317").reasonCode, "defer_reserve_floor");
    assert.equal(action(POLICY.highConfidence, "INV-EUR-901").action, "escalate");
    assert.equal(action(POLICY.highConfidence, "INV-EUR-901").reasonCode, "escalate_reserve_floor");
  });

  it("lowers the autonomous cap when the customer email contradicts the forecast", () => {
    assert.equal(confidenceFromEmail(null).confidence, POLICY.highConfidence);
    assert.equal(confidenceFromEmail(CONFLICTING_EMAIL.body).confidence, POLICY.lowConfidence);
    assert.equal(autonomousCapUsd(POLICY.highConfidence), 4000);
    assert.equal(autonomousCapUsd(POLICY.lowConfidence), 1000);
    assert.equal(action(POLICY.lowConfidence, "INV-EUR-220").needsApproval, true);
    assert.equal(action(POLICY.lowConfidence, "INV-EUR-220").action, "convert");
  });

  it("funds only the obligation the deposit unlocks", () => {
    const before = action(POLICY.lowConfidence, "INV-USD-317");
    const after = action(POLICY.lowConfidence, "INV-USD-317", POLICY.openingUsdTarget + POLICY.recalcDepositUsd);
    assert.equal(before.action, "defer");
    assert.equal(after.action, "fund");
    assert.equal(action(POLICY.lowConfidence, "INV-GBP-088", POLICY.openingUsdTarget + POLICY.recalcDepositUsd).action, "defer");
    assert.equal(action(POLICY.lowConfidence, "INV-EUR-901", POLICY.openingUsdTarget + POLICY.recalcDepositUsd).action, "escalate");
    const marked = markAffected(planAt(POLICY.lowConfidence).decisions, planAt(POLICY.lowConfidence, POLICY.openingUsdTarget + POLICY.recalcDepositUsd).decisions);
    assert.equal(marked.find((item) => item.obligationId === "INV-USD-317")?.affected, true);
    assert.equal(marked.find((item) => item.obligationId === "INV-EUR-220")?.affected, false);
    assert.equal(marked.find((item) => item.obligationId === "INV-GBP-088")?.affected, false);
  });

  it("escalates a conversion that fits the floor but exceeds the high cap", () => {
    const sample = OBLIGATIONS.find((item) => item.id === "INV-EUR-220");
    assert.ok(sample);
    const huge = { ...sample, id: "BIG", amount: 5000, dueInHours: 10 };
    const plan = buildPlan({
      obligations: [huge],
      usdAvailable: 20000,
      balances: { USD: 20000, EUR: 0, GBP: 0 },
      usdPerUnit: MOCK_USD_PER_UNIT,
      confidence: 0.9,
    });
    assert.equal(plan.decisions[0]?.action, "escalate");
    assert.equal(plan.decisions[0]?.reasonCode, "escalate_above_ceiling");
  });

  it("keeps the coded action when the model disagrees", () => {
    const plan = planAt(POLICY.highConfidence);
    const applied = applyExplanations(
      plan.decisions,
      plan.decisions.map((item) => ({
        obligationId: item.obligationId,
        action: "fund" as const,
        explanation: "Pay it anyway.",
      })),
    );
    const eur = applied.decisions.find((item) => item.obligationId === "INV-EUR-220");
    assert.equal(eur?.action, "convert");
    assert.equal(eur?.explanationSource, "policy");
    assert.equal(applied.overrides.length > 0, true);
    const ship = applied.decisions.find((item) => item.obligationId === "INV-SHIP-1042");
    assert.equal(ship?.explanation, "Pay it anyway.");
    assert.equal(ship?.explanationSource, "model");
  });

  it("accepts a quote inside the approval band and rejects a large move", () => {
    assert.equal(withinApprovalDrift(2011.88, 2030), true);
    assert.equal(withinApprovalDrift(2011.88, 2200), false);
  });

  it("parses a fenced model proposal and ignores a non-action", () => {
    const parsed = parseProposal('Sure.\n```json\n{"summary":"ok","decisions":[{"obligationId":"INV-EUR-220","action":"convert","explanation":"Because of the fee."}]}\n```');
    assert.equal(parsed?.decisions[0]?.explanation, "Because of the fee.");
    assert.equal(parseProposal('{"decisions":[{"obligationId":"x","action":"wire"}]}'), null);
  });

  it("selects mock mode until both sandbox keys exist", () => {
    assert.equal(resolveMode({}), "mock");
    assert.equal(resolveMode({ TREASURY_MODE: "mock", AIRWALLEX_CLIENT_ID: "id", AIRWALLEX_API_KEY: "key" }), "mock");
    assert.equal(resolveMode({ AIRWALLEX_CLIENT_ID: "id", AIRWALLEX_API_KEY: "key" }), "sandbox");
    assert.throws(() => resolveMode({ TREASURY_MODE: "sandbox" }), /AIRWALLEX_CLIENT_ID/);
  });
});
