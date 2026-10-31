import { indicativeUsdPerUnit } from "../airwallex";
import { missingRequiredFields, prepareBeneficiary } from "../airwallex/http-client";
import { createConversionRecovering, createTransferRecovering } from "../airwallex/recover";
import type { AirwallexClient, Balance, GlobalAccount } from "../airwallex/types";
import { resolveOperatingCap } from "../env";
import { amountString, money, round2 } from "../money";
import {
  POLICY,
  applyExplanations,
  buildPlan,
  confidenceFromEmail,
  markAffected,
  payoutFunding,
  resolveSwiftFee,
  withinApprovalDrift,
  type PolicyDecision,
  type PolicySnapshot,
} from "../policy/engine";
import type { Planner } from "../planner/planner";
import { CONFLICTING_EMAIL, FORECAST, OBLIGATIONS, type Obligation } from "../scenario/seed";
import { waitForBalanceCredit } from "./balance-wait";
import { IdempotencyKeys } from "./ids";
import { advanceTransferToPaid } from "./transfer-ladder";

export interface AuditEvent {
  at: string;
  act: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface Approval {
  obligationId: string;
  payee: string;
  action: "convert";
  buyAmount: number;
  buyCurrency: string;
  sellAmount: number;
  sellCurrency: "USD";
  fee: number;
  status: "approved" | "declined";
  at: string;
}

export interface ExecutionProof {
  obligationId: string;
  quoteId?: string;
  quoteSellAmount?: number;
  quoteUsage?: string;
  conversionId?: string;
  conversionRequestId: string;
  conversionStatus?: string;
  beneficiaryId?: string;
  schemaPath?: string;
  transferId?: string;
  transferRequestId: string;
  transferStatus?: string;
  feeAmount?: number;
  reserveUsd?: number;
  reserveIntact?: boolean;
}

type ActName = "idle" | "funded" | "planned" | "shocked" | "recalculated" | "approved" | "declined" | "executed";

interface SessionData {
  act: ActName;
  narrative: string;
  confidence: number;
  confidenceReason: string;
  emailVisible: boolean;
  balances: Balance[];
  decisions: PolicyDecision[];
  snapshot: PolicySnapshot | null;
  approval: Approval | null;
  execution: ExecutionProof | null;
  warning: string | null;
  usdAccountId: string | null;
  openingDeposited: boolean;
  shockApplied: boolean;
  recalcDeposited: boolean;
  audit: AuditEvent[];
}

export interface DeskView {
  mode: "mock" | "sandbox";
  planner: { id: string; label: string };
  act: ActName;
  narrative: string;
  confidence: number;
  confidenceReason: string;
  forecast: typeof FORECAST;
  email: typeof CONFLICTING_EMAIL | null;
  balances: Array<{ currency: string; available: number; pending: number; reserved: number }>;
  reserveFloorUsd: number;
  usdAvailable: number;
  liveUsd: number;
  operatingCapUsd: number | null;
  warning: string | null;
  obligations: Array<
    Obligation & {
      action?: PolicyDecision["action"];
      reasonCode?: string;
      explanation?: string;
      explanationSource?: PolicyDecision["explanationSource"];
      needsApproval?: boolean;
      usdCost?: number;
      fee?: number;
      buyAmount?: number;
      affected?: boolean;
      settlement: "open" | "queued" | "sent" | "deferred" | "escalated";
    }
  >;
  snapshot: PolicySnapshot | null;
  approval: Approval | null;
  execution: ExecutionProof | null;
  audit: AuditEvent[];
  gates: {
    canPlan: boolean;
    canShock: boolean;
    canRecalc: boolean;
    canApprove: boolean;
    canDecline: boolean;
    canExecute: boolean;
  };
  policy: {
    reserveFloorUsd: number;
    confidenceThreshold: number;
    autonomousConversionUsd: { high: number; low: number };
    swiftFeeEur: number;
    swiftFeeBaseEur: number;
    swiftFeePadEur: number;
    cheapestRule: string;
  };
}

function cash(balances: Balance[], currency: string): number {
  const rows = balances.filter(
    (row) => row.currency === currency && (row.account_type == null || row.account_type === "cash"),
  );
  return round2(rows.reduce((sum, row) => sum + (row.available_amount ?? 0), 0));
}

function balanceMap(balances: Balance[]): Record<string, number> {
  return {
    USD: cash(balances, "USD"),
    EUR: cash(balances, "EUR"),
    GBP: cash(balances, "GBP"),
  };
}

function isUsdLocal(account: GlobalAccount): boolean {
  if (account.status === "CLOSED") return false;
  const features = [...(account.required_features ?? []), ...(account.supported_features ?? [])];
  return features.some((feature) => feature.currency === "USD" && feature.transfer_method !== "SWIFT");
}

interface OperatingBook {
  usd: number;
  eur: number;
  gbp: number;
}

export class TreasurySession {
  private data: SessionData;
  private readonly cap: number | null;
  private book: OperatingBook | null = null;
  private liveBalances: Balance[] = [];

  constructor(
    private readonly client: AirwallexClient,
    private readonly planner: Planner,
    private readonly ids = new IdempotencyKeys(),
    options?: { operatingCapUsd?: number | null },
  ) {
    this.cap =
      options && Object.prototype.hasOwnProperty.call(options, "operatingCapUsd")
        ? (options.operatingCapUsd ?? null)
        : resolveOperatingCap();
    this.data = this.fresh();
  }

  reset(): DeskView {
    this.client.reset?.();
    this.ids.clear();
    this.book = null;
    this.liveBalances = [];
    this.data = this.fresh();
    this.audit("reset", "Desk reset. Mock ledger cleared. A sandbox wallet is left as it is.");
    return this.view();
  }

  async setup(): Promise<DeskView> {
    if (this.data.openingDeposited) {
      this.liveBalances = await this.client.getBalances();
      this.publishBalances();
      this.audit("setup", "Opening deposit already applied. Balances re-read.");
      return this.view();
    }
    const accounts = await this.client.listGlobalAccounts();
    let account = accounts.find(isUsdLocal);
    if (!account) {
      account = await this.client.createGlobalAccount({
        request_id: this.ids.get("global-account:USD:US"),
        country_code: "US",
        nick_name: "Aether Foundry USD",
        required_features: [{ currency: "USD", transfer_method: "LOCAL" }],
      });
      this.audit("setup", "Opened a USD local Global Account.", { id: account.id });
    } else {
      this.audit("setup", "Reused an existing USD Global Account.", { id: account.id });
    }
    this.data.usdAccountId = account.id;
    const target = this.cap ?? POLICY.openingUsdTarget;
    const before = await this.client.getBalances();
    const beforeUsd = cash(before, "USD");
    const shortfall = round2(target - beforeUsd);
    if (shortfall >= 1) {
      const deposit = await this.client.simulateDeposit({
        global_account_id: account.id,
        amount: shortfall,
        payer_name: "Seed funding",
        payer_country: "US",
        reference: "ATC opening cash",
      });
      this.liveBalances = await waitForBalanceCredit(() => this.client.getBalances(), "USD", beforeUsd, shortfall);
      this.audit("setup", `Simulated a USD ${shortfall.toFixed(2)} deposit. Deposit status ${deposit.status ?? "unknown"}. Polled balances until the credit appeared.`, {
        depositId: deposit.id,
        status: deposit.status,
      });
    } else {
      this.liveBalances = before;
      this.audit("setup", `Live USD is already at or above the ${money(target, "USD")} operating target. No opening deposit.`);
    }
    this.openOperatingBook(target);
    this.data.openingDeposited = true;
    this.data.act = "funded";
    this.data.narrative = this.cap
      ? `Operating book is ${money(cash(this.data.balances, "USD"), "USD")} under the sandbox demo cap. Reserve floor is ${money(POLICY.reserveFloorUsd, "USD")}. Live wallet USD is ${money(cash(this.liveBalances, "USD"), "USD")}.`
      : `Operating cash is on the blotter. Reserve floor is ${money(POLICY.reserveFloorUsd, "USD")}. Five obligations fall due inside 72 hours.`;
    return this.view();
  }

  async plan(): Promise<DeskView> {
    this.requireFunded();
    await this.replan("plan", null);
    this.data.act = "planned";
    this.data.narrative = "Policy ranked the book. The model, if configured, only explains those actions.";
    return this.view();
  }

  async shock(): Promise<DeskView> {
    this.requireFunded();
    if (this.data.decisions.length === 0) throw new Error("Build a plan before applying the customer email.");
    const previous = this.data.decisions;
    this.data.emailVisible = true;
    this.data.shockApplied = true;
    const scored = confidenceFromEmail(CONFLICTING_EMAIL.body);
    this.data.confidence = scored.confidence;
    this.data.confidenceReason = scored.reasonCode;
    this.audit("shock", "Conflicting customer email lowered forecast confidence. The threshold lives in policy code.", {
      confidence: scored.confidence,
      reasonCode: scored.reasonCode,
    });
    await this.replan("shock", previous);
    this.data.act = "shocked";
    const pending = this.data.decisions.find((item) => item.needsApproval);
    this.data.narrative = pending
      ? `${pending.payee} still converts, but confidence ${this.data.confidence.toFixed(2)} puts it over the autonomous cap. A person has to approve that conversion.`
      : "The email is on file. No conversion crossed the lower autonomous cap.";
    return this.view();
  }

  async recalc(): Promise<DeskView> {
    this.requireFunded();
    if (!this.data.shockApplied) throw new Error("Apply the email shock before the inbound deposit.");
    if (!this.data.usdAccountId) throw new Error("No USD Global Account is on this run.");
    const previous = this.data.decisions;
    if (!this.data.recalcDeposited) {
      const beforeUsd = cash(this.liveBalances, "USD");
      const deposit = await this.client.simulateDeposit({
        global_account_id: this.data.usdAccountId,
        amount: POLICY.recalcDepositUsd,
        payer_name: "Harbor Receipts LLC",
        payer_country: "US",
        reference: "ATC partial receipt",
      });
      this.liveBalances = await waitForBalanceCredit(
        () => this.client.getBalances(),
        "USD",
        beforeUsd,
        POLICY.recalcDepositUsd,
      );
      if (this.book) this.book.usd = round2(this.book.usd + POLICY.recalcDepositUsd);
      this.data.recalcDeposited = true;
      this.publishBalances();
      this.audit("recalc", `Simulated an inbound USD ${POLICY.recalcDepositUsd.toFixed(2)} deposit from Harbor Receipts LLC. Deposit status ${deposit.status ?? "unknown"}. Waited until the live balance moved.`, {
        depositId: deposit.id,
      });
    }
    await this.replan("recalc", previous);
    this.data.act = "recalculated";
    const changed = this.data.decisions.filter((item) => item.affected).map((item) => item.obligationId);
    this.data.narrative =
      changed.length > 0
        ? `Recalculated after the deposit. Changed: ${changed.join(", ")}. Unchanged decisions keep their prior action.`
        : "Recalculated after the deposit. No obligation changed action.";
    return this.view();
  }

  async approve(): Promise<DeskView> {
    const pending = this.pendingConversion();
    if (!pending) throw new Error("Nothing is waiting for approval.");
    this.data.approval = {
      obligationId: pending.obligationId,
      payee: pending.payee,
      action: "convert",
      buyAmount: pending.buyAmount,
      buyCurrency: pending.buyCurrency,
      sellAmount: pending.sellAmount,
      sellCurrency: "USD",
      fee: pending.fee,
      status: "approved",
      at: new Date().toISOString(),
    };
    this.data.act = "approved";
    this.audit("approve", `Approved ${pending.payee}: sell ${money(pending.sellAmount, "USD")} to buy ${money(pending.buyAmount, pending.buyCurrency)}.`, {
      obligationId: pending.obligationId,
    });
    this.data.narrative = "Approval is bound to the payee, the buy amount, and the estimated USD sell. A quote that moves outside that band needs a new approval.";
    return this.view();
  }

  async decline(): Promise<DeskView> {
    const pending = this.pendingConversion();
    if (!pending) throw new Error("Nothing is waiting for approval.");
    this.data.approval = {
      obligationId: pending.obligationId,
      payee: pending.payee,
      action: "convert",
      buyAmount: pending.buyAmount,
      buyCurrency: pending.buyCurrency,
      sellAmount: pending.sellAmount,
      sellCurrency: "USD",
      fee: pending.fee,
      status: "declined",
      at: new Date().toISOString(),
    };
    this.data.act = "declined";
    this.audit("decline", `Declined the ${pending.payee} conversion. No FX quote will be booked.`);
    this.data.narrative = "The conversion stays unbooked. Escalations and defers are unchanged.";
    return this.view();
  }

  async execute(): Promise<DeskView> {
    if (!this.data.recalcDeposited) {
      throw new Error("Run the inbound deposit before execution so the plan has been recalculated.");
    }
    if (this.data.execution?.transferStatus === "PAID" && this.data.execution.reserveIntact) {
      this.audit("execute", "Execution already reached PAID and the reserve floor held. Not booking again.");
      return this.view();
    }
    const decision = this.data.decisions.find((item) => item.action === "convert");
    if (!decision) throw new Error("The plan has no conversion to execute.");
    const obligation = OBLIGATIONS.find((item) => item.id === decision.obligationId);
    if (!obligation?.beneficiary) throw new Error(`${decision.obligationId} has no beneficiary profile.`);
    if (decision.needsApproval) {
      const approval = this.data.approval;
      if (!approval || approval.status !== "approved" || approval.obligationId !== decision.obligationId) {
        throw new Error("This conversion is over the autonomous cap. Approve it before execution.");
      }
      if (
        approval.buyAmount !== decision.buyAmount ||
        approval.buyCurrency !== decision.buyCurrency ||
        approval.payee !== decision.payee
      ) {
        throw new Error("The approval does not match the current payee and buy amount.");
      }
    }

    const proof: ExecutionProof = this.data.execution ?? {
      obligationId: decision.obligationId,
      conversionRequestId: this.ids.get(`conversion:${decision.obligationId}`),
      transferRequestId: this.ids.get(`transfer:${decision.obligationId}`),
    };
    this.data.execution = proof;

    if (!proof.conversionId) {
      if (!proof.quoteId) {
        const quote = await this.client.createQuote({
          buy_currency: decision.buyCurrency,
          sell_currency: "USD",
          buy_amount: decision.buyAmount,
          validity: "MIN_30",
        });
        proof.quoteId = quote.quote_id;
        proof.quoteSellAmount = round2(Number(quote.sell_amount));
        proof.quoteUsage = quote.usage;
        this.audit("execute", `Booked FX quote ${quote.quote_id} (usage ${quote.usage ?? "unset"}). This run submits that quote once.`, {
          clientRate: quote.client_rate,
          sellAmount: proof.quoteSellAmount,
          usage: quote.usage,
        });
      }
      const quotedSell = proof.quoteSellAmount ?? decision.sellAmount;
      this.liveBalances = await this.client.getBalances();
      this.publishBalances();
      if (decision.needsApproval && this.data.approval && !withinApprovalDrift(this.data.approval.sellAmount, quotedSell)) {
        this.data.approval = null;
        decision.sellAmount = quotedSell;
        decision.usdCost = quotedSell;
        decision.needsApproval = true;
        throw new Error(
          `Quote sell ${money(quotedSell, "USD")} moved outside the approved band. Approve the new amount. The unused quote is kept so it is not booked twice.`,
        );
      }
      const usdNow = cash(this.data.balances, "USD");
      if (round2(usdNow - quotedSell) + 0.001 < POLICY.reserveFloorUsd) {
        throw new Error(
          `Quote would leave ${money(round2(usdNow - quotedSell), "USD")}, under the ${money(POLICY.reserveFloorUsd, "USD")} floor. Conversion not booked.`,
        );
      }
      const conversion = await createConversionRecovering(this.client, {
        request_id: proof.conversionRequestId,
        buy_currency: decision.buyCurrency,
        sell_currency: "USD",
        buy_amount: amountString(decision.buyAmount),
        quote_id: proof.quoteId!,
      });
      proof.conversionId = conversion.conversion_id;
      proof.conversionStatus = conversion.status;
      if (this.book) {
        this.book.usd = round2(this.book.usd - quotedSell);
        this.book.eur = round2(this.book.eur + decision.buyAmount);
      }
      this.liveBalances = await this.client.getBalances();
      this.publishBalances();
      this.audit("execute", `Conversion ${conversion.conversion_id} is ${conversion.status}. Quote ${proof.quoteId} was submitted once (reported usage ${proof.quoteUsage ?? "unset"}).`, {
        requestId: proof.conversionRequestId,
      });
    }

    if (!proof.beneficiaryId) {
      const schema = await this.client.beneficiarySchema({
        account_currency: obligation.currency,
        bank_country_code: obligation.schema.bank_country_code,
        entity_type: obligation.schema.entity_type,
        transfer_method: obligation.schema.transfer_method,
        local_clearing_system: obligation.schema.local_clearing_system,
      });
      proof.schemaPath = schema.pathUsed;
      if (schema.fields.length === 0) {
        throw new Error(
          `Beneficiary schema from ${schema.pathUsed} did not include a fields array. Refusing to guess required payout fields.`,
        );
      }
      const beneficiaryPayload = prepareBeneficiary(obligation.beneficiary);
      const missing = missingRequiredFields(schema.fields, beneficiaryPayload);
      if (missing.length > 0) {
        throw new Error(`Beneficiary payload is missing schema fields: ${missing.join(", ")}`);
      }
      const beneficiary = await this.client.createBeneficiary(beneficiaryPayload);
      proof.beneficiaryId = beneficiary.id;
      this.audit("execute", `Created beneficiary ${beneficiary.id} after schema ${schema.pathUsed}.`);
    }

    if (!proof.transferId) {
      const funding = payoutFunding(obligation);
      const transfer = await createTransferRecovering(this.client, {
        request_id: proof.transferRequestId,
        beneficiary_id: proof.beneficiaryId!,
        transfer_amount: amountString(obligation.amount),
        transfer_currency: obligation.currency,
        source_currency: obligation.currency,
        transfer_method: obligation.transferMethod,
        reason: obligation.reason,
        reference: `${obligation.id} ${obligation.payee}`.slice(0, 140),
        fee_paid_by: "PAYER",
      });
      proof.transferId = transfer.id;
      proof.transferStatus = transfer.status;
      proof.feeAmount = transfer.fee_amount;
      if (this.book && obligation.currency === "EUR") {
        const payerPays = transfer.amount_payer_pays ?? round2(obligation.amount + (transfer.fee_amount ?? funding.feeBase));
        this.book.eur = round2(this.book.eur - payerPays);
      }
      this.audit("execute", `Transfer ${transfer.id} created at ${transfer.status}. Payer pays ${transfer.amount_payer_pays ?? funding.buyAmount} ${obligation.currency}, including fee ${transfer.fee_amount ?? funding.feeBase}.`, {
        requestId: proof.transferRequestId,
      });
    }

    const status = await advanceTransferToPaid(this.client, {
      id: proof.transferId!,
      status: proof.transferStatus,
    });
    proof.transferStatus = status;
    this.audit("execute", `Transfer ${proof.transferId} is ${status}. PROCESSING was not simulated; SENT then PAID were.`);

    this.liveBalances = await this.client.getBalances();
    this.publishBalances();
    const reserveUsd = cash(this.data.balances, "USD");
    proof.reserveUsd = reserveUsd;
    proof.reserveIntact = reserveUsd + 0.001 >= POLICY.reserveFloorUsd;
    this.data.act = "executed";
    const reserveLabel = this.cap ? "Operating book" : "Available cash";
    this.data.narrative = proof.reserveIntact
      ? `Supplier transfer is ${proof.transferStatus}. ${reserveLabel} ${money(reserveUsd, "USD")} remains above the ${money(POLICY.reserveFloorUsd, "USD")} floor.`
      : `Transfer is ${proof.transferStatus}, but ${reserveLabel.toLowerCase()} ${money(reserveUsd, "USD")} is under the floor.`;
    this.audit("execute", this.data.narrative, { reserveUsd, reserveIntact: proof.reserveIntact });
    return this.view();
  }

  view(): DeskView {
    const balances = ["USD", "EUR", "GBP"].map((currency) => ({
      currency,
      available: cash(this.data.balances, currency),
      pending: this.pendingOf(currency),
      reserved: this.reservedOf(currency),
    }));
    const decisionById = new Map(this.data.decisions.map((item) => [item.obligationId, item]));
    return {
      mode: this.client.mode,
      planner: { id: this.planner.id, label: this.planner.label },
      act: this.data.act,
      narrative: this.data.narrative,
      confidence: this.data.confidence,
      confidenceReason: this.data.confidenceReason,
      forecast: FORECAST,
      email: this.data.emailVisible ? CONFLICTING_EMAIL : null,
      balances,
      reserveFloorUsd: POLICY.reserveFloorUsd,
      usdAvailable: cash(this.data.balances, "USD"),
      liveUsd: cash(this.liveBalances.length > 0 ? this.liveBalances : this.data.balances, "USD"),
      operatingCapUsd: this.cap,
      warning: this.data.warning,
      obligations: OBLIGATIONS.map((obligation) => {
        const decision = decisionById.get(obligation.id);
        return {
          ...obligation,
          beneficiary: undefined,
          action: decision?.action,
          reasonCode: decision?.reasonCode,
          explanation: decision?.explanation,
          explanationSource: decision?.explanationSource,
          needsApproval: decision?.needsApproval,
          usdCost: decision?.usdCost,
          fee: decision?.fee,
          buyAmount: decision?.buyAmount,
          affected: decision?.affected,
          settlement: settlementFor(obligation.id, decision, this.data.execution),
        };
      }),
      snapshot: this.data.snapshot,
      approval: this.data.approval,
      execution: this.data.execution,
      audit: [...this.data.audit].reverse(),
      gates: {
        canPlan: this.data.openingDeposited,
        canShock: this.data.decisions.length > 0,
        canRecalc: this.data.shockApplied,
        canApprove: Boolean(this.pendingConversion()) && this.data.approval?.status !== "approved",
        canDecline: Boolean(this.pendingConversion()) && this.data.approval?.status !== "declined",
        canExecute:
          this.data.recalcDeposited &&
          this.data.execution?.transferStatus !== "PAID" &&
          (!this.pendingConversion() || this.data.approval?.status === "approved"),
      },
      policy: {
        reserveFloorUsd: POLICY.reserveFloorUsd,
        confidenceThreshold: POLICY.confidenceThreshold,
        autonomousConversionUsd: POLICY.autonomousConversionUsd,
        swiftFeeEur: resolveSwiftFee().total,
        swiftFeeBaseEur: resolveSwiftFee().base,
        swiftFeePadEur: resolveSwiftFee().pad,
        cheapestRule:
          "When the book cannot be paid without breaking the reserve floor, the cheapest non-critical obligation is deferred.",
      },
    };
  }

  private async replan(act: string, previous: PolicyDecision[] | null): Promise<void> {
    this.liveBalances = await this.client.getBalances();
    this.publishBalances();
    const usdPerUnit = await this.loadRates();
    const built = buildPlan({
      obligations: OBLIGATIONS,
      usdAvailable: cash(this.data.balances, "USD"),
      balances: balanceMap(this.data.balances),
      usdPerUnit,
      confidence: this.data.confidence,
    });
    let proposal = null;
    try {
      proposal = await this.planner.propose({
        obligations: OBLIGATIONS,
        decisions: built.decisions,
        snapshot: built.snapshot,
        emailBody: this.data.emailVisible ? CONFLICTING_EMAIL.body : null,
        forecastNote: FORECAST.supportedNote,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Planner failed";
      this.audit(act, `Planner failed (${message}). Policy explanations stand.`);
    }
    const applied = applyExplanations(built.decisions, proposal?.decisions ?? null);
    for (const override of applied.overrides) {
      this.audit(act, `Policy overrode the model. ${override}`);
    }
    if (proposal && applied.overrides.length === 0) {
      this.audit(act, `${this.planner.label} explained the coded plan.`);
    } else if (!proposal) {
      this.audit(act, `${this.planner.label} left the coded explanations in place.`);
    }
    this.data.decisions = markAffected(previous, applied.decisions);
    this.data.snapshot = built.snapshot;
    if (built.snapshot.canSettleAll && this.cap == null) {
      this.data.warning =
        "Available cash can cover every obligation and still leave the reserve floor. Set TREASURY_OPERATING_CAP to run the scripted shortfall against a virtual operating book.";
    }
  }

  private openOperatingBook(target: number): void {
    const liveUsd = cash(this.liveBalances, "USD");
    if (this.cap == null) {
      this.book = null;
      this.data.balances = this.liveBalances;
      if (liveUsd > target + 1) {
        this.data.warning =
          "This wallet is above the scripted opening balance. The reserve floor still applies, but the shortfall story is written for about USD 15,500 available. There is no sandbox withdrawal simulation.";
      }
      return;
    }
    this.book = { usd: round2(Math.min(liveUsd, this.cap)), eur: 0, gbp: 0 };
    if (liveUsd > this.cap + 1) {
      this.data.warning = `Sandbox demo cap is on. Decisions use an operating book of ${money(this.cap, "USD")}, not the live wallet of ${money(liveUsd, "USD")}. Airwallex has no wallet-withdrawal simulation; the cap is the stand-in. Payouts still execute on the live wallet.`;
    }
    this.publishBalances();
  }

  private publishBalances(): void {
    if (!this.book) {
      if (this.liveBalances.length > 0) this.data.balances = this.liveBalances;
      return;
    }
    this.data.balances = (["USD", "EUR", "GBP"] as const).map((currency) => ({
      account_type: "cash",
      currency,
      available_amount: this.book![currency.toLowerCase() as "usd" | "eur" | "gbp"],
      pending_amount: 0,
      reserved_amount: 0,
      total_amount: this.book![currency.toLowerCase() as "usd" | "eur" | "gbp"],
    }));
  }

  private async loadRates(): Promise<Record<string, number>> {
    const rates: Record<string, number> = { USD: 1 };
    for (const currency of ["EUR", "GBP"] as const) {
      const quote = await this.client.getCurrentRate({
        buy_currency: currency,
        sell_currency: "USD",
        buy_amount: 1000,
      });
      rates[currency] = indicativeUsdPerUnit(quote);
    }
    this.audit("rates", `Indicative USD rates: EUR ${rates.EUR}, GBP ${rates.GBP}. Quotes, not these rates, book the conversion.`);
    return rates;
  }

  private requireFunded(): void {
    if (!this.data.openingDeposited) throw new Error("Fund the wallet before planning.");
  }

  private pendingConversion(): PolicyDecision | undefined {
    return this.data.decisions.find((item) => item.needsApproval && item.action === "convert");
  }

  private pendingOf(currency: string): number {
    return round2(
      this.data.balances
        .filter((row) => row.currency === currency)
        .reduce((sum, row) => sum + (row.pending_amount ?? 0), 0),
    );
  }

  private reservedOf(currency: string): number {
    return round2(
      this.data.balances
        .filter((row) => row.currency === currency)
        .reduce((sum, row) => sum + (row.reserved_amount ?? 0), 0),
    );
  }

  private fresh(): SessionData {
    const scored = confidenceFromEmail(null);
    return {
      act: "idle",
      narrative: "Fund the sandbox, or the mock ledger, then walk the acts in order.",
      confidence: scored.confidence,
      confidenceReason: scored.reasonCode,
      emailVisible: false,
      balances: [],
      decisions: [],
      snapshot: null,
      approval: null,
      execution: null,
      warning: null,
      usdAccountId: null,
      openingDeposited: false,
      shockApplied: false,
      recalcDeposited: false,
      audit: [],
    };
  }

  private audit(act: string, message: string, detail?: Record<string, unknown>): void {
    this.data.audit.push({ at: new Date().toISOString(), act, message, detail });
  }
}

function settlementFor(
  id: string,
  decision: PolicyDecision | undefined,
  execution: ExecutionProof | null,
): "open" | "queued" | "sent" | "deferred" | "escalated" {
  if (execution?.obligationId === id && execution.transferStatus === "PAID") return "sent";
  if (!decision) return "open";
  if (decision.action === "defer") return "deferred";
  if (decision.action === "escalate") return "escalated";
  if (decision.action === "fund" || decision.action === "convert") return "queued";
  return "open";
}
