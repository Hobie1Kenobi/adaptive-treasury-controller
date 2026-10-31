import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AirwallexError } from "../src/airwallex/errors";
import { HttpAirwallexClient, missingRequiredFields, prepareBeneficiary } from "../src/airwallex/http-client";
import { MockAirwallexClient } from "../src/airwallex/mock-client";
import { createTransferRecovering, isIdempotentReplay, priorTransferId } from "../src/airwallex/recover";
import type { BeneficiaryPayload, Transfer } from "../src/airwallex/types";
import { round2 } from "../src/money";
import { payoutFunding, resolveSwiftFee } from "../src/policy/engine";
import { DeterministicPlanner } from "../src/planner/planner";
import { OBLIGATIONS } from "../src/scenario/seed";
import { waitForBalanceCredit } from "../src/treasury/balance-wait";
import { IdempotencyKeys } from "../src/treasury/ids";
import { TreasurySession } from "../src/treasury/session";
import { advanceTransferToPaid } from "../src/treasury/transfer-ladder";

const env = {
  AIRWALLEX_CLIENT_ID: "client_test",
  AIRWALLEX_API_KEY: "key_test",
  AIRWALLEX_BASE_URL: "https://api.sandbox.airwallex.com",
};

describe("sandbox fixes", () => {
  it("treats a 200 schema response without fields as a miss and uses generate", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const href = String(url);
      calls.push(href);
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (href.endsWith("/authentication/login")) {
        return json(200, { token: "tok_test", expires_at: "2030-01-01T00:00:00+0000" });
      }
      if (href.endsWith("/beneficiary_api_schemas/generate")) {
        return json(200, {
          fields: [
            { path: "beneficiary.type", required: true },
            { path: "transfer_method", required: true },
            { path: "beneficiary.bank_details.iban", required: true },
          ],
        });
      }
      if (href.endsWith("/beneficiaries/schema")) {
        return json(200, { errors: [], schema: { type: "object" } });
      }
      return json(500, { message: href });
    };
    const client = new HttpAirwallexClient(env, fetchImpl);
    const schema = await client.beneficiarySchema({
      account_currency: "EUR",
      bank_country_code: "DE",
      entity_type: "COMPANY",
      transfer_method: "SWIFT",
    });
    assert.equal(schema.pathUsed, "/beneficiary_api_schemas/generate");
    assert.equal(schema.fields.length, 3);
    assert.equal(calls.some((call) => call.endsWith("/beneficiaries/schema")), false);

    const generateMiss: typeof fetch = async (url, init) => {
      const href = String(url);
      calls.push(`miss:${href}`);
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (href.endsWith("/authentication/login")) {
        return json(200, { token: "tok_test", expires_at: "2030-01-01T00:00:00+0000" });
      }
      if (href.endsWith("/beneficiary_api_schemas/generate")) {
        return json(200, { errors: [], schema: { type: "object" } });
      }
      if (href.endsWith("/beneficiaries/schema")) {
        return json(200, { fields: [{ path: "beneficiary.bank_details.swift_code", required: true }] });
      }
      return json(500, { message: href });
    };
    const fallback = new HttpAirwallexClient(env, generateMiss);
    const second = await fallback.beneficiarySchema({
      account_currency: "EUR",
      bank_country_code: "DE",
      entity_type: "COMPANY",
      transfer_method: "SWIFT",
    });
    assert.equal(second.pathUsed, "/beneficiaries/schema");
    assert.equal(second.fields[0]?.path, "beneficiary.bank_details.swift_code");
  });

  it("skips transfer_method and sends beneficiary.type BANK_ACCOUNT", () => {
    const raw: BeneficiaryPayload = {
      transfer_methods: ["SWIFT"],
      beneficiary: {
        type: "COMPANY",
        entity_type: "COMPANY",
        company_name: "Rheinwerk Components GmbH",
        bank_details: { iban: "DE89370400440532013000", swift_code: "DEUTDEFF" },
      },
    };
    const prepared = prepareBeneficiary(raw);
    assert.equal(prepared.beneficiary.type, "BANK_ACCOUNT");
    assert.equal(prepared.beneficiary.entity_type, "COMPANY");
    const missing = missingRequiredFields(
      [
        { path: "transfer_method", required: true },
        { path: "beneficiary.type", required: true },
        { path: "beneficiary.bank_details.iban", required: true },
      ],
      prepared,
    );
    assert.deepEqual(missing, []);
    const seed = OBLIGATIONS.find((item) => item.id === "INV-EUR-220");
    assert.equal(seed?.beneficiary?.beneficiary.type, "BANK_ACCOUNT");
  });

  it("advances SCHEDULED transfers SENT then PAID and tolerates a PROCESSING failure", async () => {
    const steps: string[] = [];
    let status = "SCHEDULED";
    const transfer: Transfer = { id: "tr_1", status };
    const client = {
      async getTransfer() {
        if (status === "SCHEDULED") status = "PROCESSING";
        return { ...transfer, status };
      },
      async transitionTransfer(_id: string, input: { next_status: string }) {
        steps.push(input.next_status);
        if (input.next_status === "PROCESSING") {
          throw new AirwallexError("operation_failed", { status: 500, code: "operation_failed" });
        }
        status = input.next_status;
        return { ...transfer, status };
      },
    };
    const paid = await advanceTransferToPaid(client, transfer);
    assert.equal(paid, "PAID");
    assert.deepEqual(steps, ["SENT", "PAID"]);
  });

  it("provisions a padded SWIFT fee instead of the kit's 12.85", () => {
    const fee = resolveSwiftFee({ SWIFT_FEE_EUR: "13.48", SWIFT_FEE_PAD_EUR: "1" });
    assert.equal(fee.base, 13.48);
    assert.equal(fee.pad, 1);
    assert.equal(fee.total, 14.48);
    const obligation = OBLIGATIONS.find((item) => item.id === "INV-EUR-220");
    assert.ok(obligation);
    const funding = payoutFunding(obligation, fee);
    assert.equal(funding.buyAmount, round2(1850 + 14.48));
    assert.ok(funding.buyAmount > 1850 + 13.48);
  });

  it("polls balances until a simulated deposit credits", async () => {
    let reads = 0;
    const balances = await waitForBalanceCredit(
      async () => {
        reads += 1;
        const available = reads < 3 ? 100 : 350;
        return [{ account_type: "cash", currency: "USD", available_amount: available }];
      },
      "USD",
      100,
      250,
      { attempts: 5, intervalMs: 1, sleep: async () => undefined },
    );
    assert.equal(reads, 3);
    assert.equal(balances[0]?.available_amount, 350);
    await assert.rejects(
      () =>
        waitForBalanceCredit(async () => [{ currency: "USD", available_amount: 0 }], "USD", 0, 10, {
          attempts: 2,
          sleep: async () => undefined,
        }),
      /not visible/,
    );
  });

  it("keeps the scripted shortfall when the live wallet is already rich", async () => {
    const rich = new MockAirwallexClient({ initial: { USD: 10_000_000, EUR: 10_000_000, GBP: 10_000_000 } });
    const capped = new TreasurySession(rich, new DeterministicPlanner(), new IdempotencyKeys(), {
      operatingCapUsd: 15500,
    });
    await capped.setup();
    const planned = await capped.plan();
    assert.equal(planned.usdAvailable, 15500);
    assert.equal(planned.liveUsd, 10_000_000);
    assert.equal(planned.operatingCapUsd, 15500);
    assert.equal(planned.obligations.find((item) => item.id === "INV-EUR-220")?.action, "convert");
    assert.equal(planned.warning, null);
    assert.match(planned.capNotice ?? "", /operating book of \$15,500\.00/);
    assert.match(planned.capNotice ?? "", /live wallet of \$10,000,000\.00/);
    assert.match(planned.capNotice ?? "", /no sandbox withdrawal simulation/);
    assert.match(planned.capNotice ?? "", /Payouts still execute on the live wallet/);
    assert.equal(planned.capNotice?.match(/Sandbox demo cap/g), null);

    const raw = new MockAirwallexClient({ initial: { USD: 10_000_000, EUR: 10_000_000, GBP: 10_000_000 } });
    const uncapped = new TreasurySession(raw, new DeterministicPlanner(), new IdempotencyKeys(), {
      operatingCapUsd: null,
    });
    await uncapped.setup();
    const livePlan = await uncapped.plan();
    assert.equal(livePlan.obligations.find((item) => item.id === "INV-EUR-220")?.action, "fund");
    assert.equal(livePlan.usdAvailable, 10_000_000);
    assert.equal(livePlan.capNotice, null);
  });

  it("recovers a replayed transfer from the id in duplicate_request_id", async () => {
    const client = new MockAirwallexClient({ initial: { EUR: 500 } });
    const input = {
      request_id: "44444444-4444-4444-8444-444444444444",
      beneficiary_id: "ben_1",
      transfer_amount: "10.00",
      transfer_currency: "EUR",
      source_currency: "EUR",
      transfer_method: "LOCAL" as const,
      reason: "goods_purchased",
      reference: "replay",
      fee_paid_by: "PAYER" as const,
    };
    const first = await client.createTransfer(input);
    await assert.rejects(() => client.createTransfer(input), (error: unknown) => {
      assert.ok(error instanceof AirwallexError);
      assert.equal(error.code, "duplicate_request_id");
      assert.equal(priorTransferId(error), first.id);
      assert.equal(isIdempotentReplay(error), true);
      return true;
    });
    const again = await createTransferRecovering(client, input);
    assert.equal(again.id, first.id);
    const balances = await client.getBalances();
    assert.equal(balances.find((row) => row.currency === "EUR")?.available_amount, 490);
  });

  it("plans with the live indicative rate instead of the mock 1.08", async () => {
    const client = new MockAirwallexClient({ rates: { USD: 1, EUR: 1.126, GBP: 1.27 } });
    const session = new TreasurySession(client, new DeterministicPlanner());
    await session.setup();
    const planned = await session.plan();
    assert.equal(planned.snapshot?.usdPerUnit.EUR, 1.126);
    const eur = planned.obligations.find((item) => item.id === "INV-EUR-220");
    const fee = resolveSwiftFee();
    assert.equal(eur?.usdCost, round2(round2(1850 + fee.total) * 1.126));
    assert.notEqual(eur?.usdCost, round2(round2(1850 + fee.total) * 1.08));
  });
});
