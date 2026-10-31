import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { missingRequiredFields } from "../src/airwallex/http-client";
import { MockAirwallexClient } from "../src/airwallex/mock-client";
import { createConversionRecovering } from "../src/airwallex/recover";
import { AirwallexError } from "../src/airwallex/errors";
import { round2 } from "../src/money";
import { POLICY, resolveSwiftFee } from "../src/policy/engine";
import { DeterministicPlanner, type Planner } from "../src/planner/planner";
import { OBLIGATIONS } from "../src/scenario/seed";
import { TreasurySession } from "../src/treasury/session";

function usd(view: { balances: Array<{ currency: string; available: number }> }): number {
  return view.balances.find((row) => row.currency === "USD")?.available ?? 0;
}

function eur(view: { balances: Array<{ currency: string; available: number }> }): number {
  return view.balances.find((row) => row.currency === "EUR")?.available ?? 0;
}

describe("mock treasury flow", () => {
  it("runs fund, plan, shock, recalc, approve, and one payout without breaching the floor", async () => {
    const client = new MockAirwallexClient();
    let conversions = 0;
    const original = client.createConversion.bind(client);
    client.createConversion = async (input) => {
      conversions += 1;
      return original(input);
    };
    const session = new TreasurySession(client, new DeterministicPlanner());

    const funded = await session.setup();
    assert.equal(usd(funded), POLICY.openingUsdTarget);
    assert.equal(funded.mode, "mock");
    assert.equal(JSON.stringify(funded).includes("DE89370400440532013000"), false);

    const planned = await session.plan();
    assert.equal(planned.obligations.find((item) => item.id === "INV-EUR-220")?.needsApproval, false);
    assert.equal(planned.gates.canExecute, false);

    const shocked = await session.shock();
    const eurDecision = shocked.obligations.find((item) => item.id === "INV-EUR-220");
    assert.equal(eurDecision?.needsApproval, true);
    assert.equal(eurDecision?.affected, true);
    assert.equal(shocked.obligations.find((item) => item.id === "INV-USD-317")?.affected, false);
    assert.equal(shocked.confidence, POLICY.lowConfidence);
    await assert.rejects(() => session.execute(), /inbound deposit/);

    const recalculated = await session.recalc();
    assert.equal(recalculated.obligations.find((item) => item.id === "INV-USD-317")?.action, "fund");
    assert.equal(recalculated.obligations.find((item) => item.id === "INV-USD-317")?.affected, true);
    assert.equal(recalculated.obligations.find((item) => item.id === "INV-EUR-220")?.action, "convert");
    assert.equal(recalculated.obligations.find((item) => item.id === "INV-EUR-220")?.affected, false);
    assert.equal(recalculated.obligations.find((item) => item.id === "INV-GBP-088")?.action, "defer");
    assert.equal(recalculated.obligations.find((item) => item.id === "INV-EUR-901")?.action, "escalate");
    assert.equal(usd(recalculated), POLICY.openingUsdTarget + POLICY.recalcDepositUsd);
    await assert.rejects(() => session.execute(), /Approve/);

    await session.approve();
    const executed = await session.execute();
    assert.equal(executed.execution?.conversionStatus, "SETTLED");
    assert.equal(executed.execution?.transferStatus, "PAID");
    const fee = resolveSwiftFee();
    const sell = round2(round2(1850 + fee.total) * 1.08);
    assert.equal(executed.execution?.quoteUsage, "MULTI_USE");
    assert.equal(executed.execution?.feeAmount, fee.base);
    assert.equal(executed.execution?.reserveIntact, true);
    assert.equal(usd(executed), round2(POLICY.openingUsdTarget + POLICY.recalcDepositUsd - sell));
    assert.equal(eur(executed), fee.pad);
    assert.ok((executed.execution?.reserveUsd ?? 0) >= POLICY.reserveFloorUsd);
    assert.equal(executed.obligations.find((item) => item.id === "INV-EUR-220")?.settlement, "sent");
    assert.equal(executed.obligations.find((item) => item.id === "INV-SHIP-1042")?.settlement, "queued");

    const again = await session.execute();
    assert.match(again.audit[0]?.message ?? "", /already reached PAID/);
    assert.equal(conversions, 1);
    assert.equal(usd(again), round2(POLICY.openingUsdTarget + POLICY.recalcDepositUsd - sell));
  });

  it("treats quotes as single-use and request ids as idempotent", async () => {
    const client = new MockAirwallexClient();
    const account = await client.createGlobalAccount({
      request_id: "11111111-1111-4111-8111-111111111111",
      country_code: "US",
      required_features: [{ currency: "USD", transfer_method: "LOCAL" }],
    });
    await client.simulateDeposit({ global_account_id: account.id, amount: 5000, payer_name: "Seed funding" });
    const quote = await client.createQuote({
      buy_currency: "EUR",
      sell_currency: "USD",
      buy_amount: 100,
      validity: "MIN_30",
    });
    assert.equal(quote.usage, "MULTI_USE");
    const request = {
      request_id: "22222222-2222-4222-8222-222222222222",
      buy_currency: "EUR",
      sell_currency: "USD",
      buy_amount: "100.00",
      quote_id: quote.quote_id,
    };
    const first = await client.createConversion(request);
    await assert.rejects(
      () => client.createConversion(request),
      (error: unknown) => error instanceof AirwallexError && error.code === "invalid_argument",
    );
    const second = await createConversionRecovering(client, request);
    assert.equal(first.conversion_id, second.conversion_id);
    assert.equal(first.status, "SETTLED");
    const balances = await client.getBalances();
    assert.equal(balances.find((row) => row.currency === "EUR")?.available_amount, 100);
    await assert.rejects(
      () =>
        client.createConversion({
          ...request,
          request_id: "33333333-3333-4333-8333-333333333333",
        }),
      (error: unknown) => error instanceof AirwallexError && error.code === "invalid_quote_id",
    );
    await assert.rejects(
      () => client.createConversion({ ...request, buy_amount: "101.00" }),
      (error: unknown) => error instanceof AirwallexError && error.code === "invalid_argument",
    );

    const transferRequest = {
      request_id: "44444444-4444-4444-8444-444444444444",
      beneficiary_id: "ben_1",
      transfer_amount: "100.00",
      transfer_currency: "EUR",
      source_currency: "EUR",
      transfer_method: "SWIFT" as const,
      reason: "goods_purchased",
      reference: "INV-EUR-220",
      fee_paid_by: "PAYER" as const,
    };
    await assert.rejects(
      () => client.createTransfer(transferRequest),
      (error: unknown) => error instanceof AirwallexError && error.code === "balance_insufficient",
    );
    const fee = resolveSwiftFee();
    const funded = await client.createQuote({
      buy_currency: "EUR",
      sell_currency: "USD",
      buy_amount: fee.base,
      validity: "MIN_30",
    });
    await client.createConversion({
      request_id: "55555555-5555-4555-8555-555555555555",
      buy_currency: "EUR",
      sell_currency: "USD",
      buy_amount: fee.base.toFixed(2),
      quote_id: funded.quote_id,
    });
    const transfer = await client.createTransfer(transferRequest);
    assert.equal(transfer.fee_amount, fee.base);
    assert.equal(transfer.amount_payer_pays, round2(100 + fee.base));
    await assert.rejects(
      () => client.transitionTransfer(transfer.id, { next_status: "PAID" }),
      /SENT/,
    );
    const sent = await client.transitionTransfer(transfer.id, { next_status: "SENT" });
    const paid = await client.transitionTransfer(sent.id, { next_status: "PAID" });
    assert.equal(paid.status, "PAID");
    const after = await client.getBalances();
    assert.equal(after.find((row) => row.currency === "EUR")?.available_amount, 0);
  });

  it("checks the prepared beneficiary against the schema", async () => {
    const client = new MockAirwallexClient();
    const obligation = OBLIGATIONS.find((item) => item.id === "INV-EUR-220");
    assert.ok(obligation?.beneficiary);
    const schema = await client.beneficiarySchema({
      account_currency: "EUR",
      bank_country_code: "DE",
      entity_type: "COMPANY",
      transfer_method: "SWIFT",
    });
    assert.deepEqual(missingRequiredFields(schema.fields, obligation.beneficiary), []);
    const broken = structuredClone(obligation.beneficiary);
    if (broken.beneficiary.bank_details) delete broken.beneficiary.bank_details.swift_code;
    assert.ok(missingRequiredFields(schema.fields, broken).includes("beneficiary.bank_details.swift_code"));
  });

  it("discards a model plan that would fund the escalated invoice", async () => {
    const planner: Planner = {
      id: "fake",
      label: "Fake model",
      async propose() {
        return {
          summary: "Pay every invoice.",
          decisions: OBLIGATIONS.map((item) => ({
            obligationId: item.id,
            action: "fund" as const,
            explanation: "Pay it anyway.",
          })),
        };
      },
    };
    const session = new TreasurySession(new MockAirwallexClient(), planner);
    await session.setup();
    const view = await session.plan();
    assert.equal(view.obligations.find((item) => item.id === "INV-EUR-901")?.action, "escalate");
    assert.match(view.audit.map((event) => event.message).join("\n"), /Policy overrode the model/);
    assert.equal(view.obligations.find((item) => item.id === "INV-SHIP-1042")?.explanation, "Pay it anyway.");
  });
});
