import { randomUUID } from "node:crypto";
import { AirwallexError } from "./errors";
import type {
  AirwallexClient,
  Balance,
  Beneficiary,
  BeneficiaryPayload,
  BeneficiarySchema,
  Conversion,
  Deposit,
  FxQuote,
  FxRate,
  GlobalAccount,
  SchemaField,
  Transfer,
} from "./types";
import { MOCK_USD_PER_UNIT, resolveSwiftFee } from "../policy/engine";
import { amountString, round2 } from "../money";

interface StoredQuote extends FxQuote {
  used: boolean;
}

function samePayload(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function schemaFields(input: {
  account_currency: string;
  bank_country_code: string;
  transfer_method: string;
}): SchemaField[] {
  const address = [
    "beneficiary.address.street_address",
    "beneficiary.address.city",
    "beneficiary.address.postcode",
    "beneficiary.address.country_code",
  ].map((path) => ({ path, required: true }));
  const common = [
    { path: "beneficiary.type", required: true },
    { path: "beneficiary.entity_type", required: true },
    { path: "beneficiary.company_name", required: true },
    { path: "beneficiary.bank_details.account_currency", required: true },
    { path: "beneficiary.bank_details.account_name", required: true },
    { path: "beneficiary.bank_details.bank_country_code", required: true },
    { path: "transfer_methods", required: true },
    ...address,
  ];
  if (input.bank_country_code === "US" && input.transfer_method === "LOCAL") {
    return [
      ...common,
      { path: "beneficiary.address.state", required: true },
      { path: "beneficiary.bank_details.account_number", required: true },
      { path: "beneficiary.bank_details.account_routing_type1", required: true },
      { path: "beneficiary.bank_details.account_routing_value1", required: true },
      { path: "beneficiary.bank_details.bank_account_category", required: true },
    ];
  }
  if (input.bank_country_code === "GB" && input.transfer_method === "LOCAL") {
    return [
      ...common,
      { path: "beneficiary.bank_details.account_number", required: true },
      { path: "beneficiary.bank_details.account_routing_type1", required: true },
      { path: "beneficiary.bank_details.account_routing_value1", required: true },
      { path: "beneficiary.bank_details.bank_name", required: true },
    ];
  }
  if (input.transfer_method === "SWIFT") {
    return [
      ...common,
      { path: "beneficiary.bank_details.iban", required: true },
      { path: "beneficiary.bank_details.swift_code", required: true },
    ];
  }
  return common;
}

export class MockAirwallexClient implements AirwallexClient {
  readonly mode = "mock" as const;
  private tokenExpiresAt = 0;
  private token = "";
  private loginCalls = 0;
  private accounts: GlobalAccount[] = [];
  private readonly available = new Map<string, number>();
  private readonly rates: Record<string, number>;

  constructor(options: { rates?: Record<string, number>; initial?: Record<string, number> } = {}) {
    this.rates = { ...MOCK_USD_PER_UNIT, ...options.rates };
    for (const [currency, amount] of Object.entries(options.initial ?? {})) {
      this.available.set(currency, amount);
    }
  }
  private readonly quotes = new Map<string, StoredQuote>();
  private readonly conversions = new Map<string, { payload: unknown; conversion: Conversion }>();
  private readonly transfers = new Map<string, { payload: unknown; transfer: Transfer }>();
  private readonly accountCreates = new Map<string, { payload: unknown; account: GlobalAccount }>();

  reset(): void {
    this.token = "";
    this.tokenExpiresAt = 0;
    this.loginCalls = 0;
    this.accounts = [];
    this.available.clear();
    this.quotes.clear();
    this.conversions.clear();
    this.transfers.clear();
    this.accountCreates.clear();
  }

  get loginCount(): number {
    return this.loginCalls;
  }

  async login(): Promise<{ token: string; expiresAt: string }> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60_000) {
      return { token: this.token, expiresAt: new Date(this.tokenExpiresAt).toISOString() };
    }
    this.loginCalls += 1;
    this.token = `mock_${randomUUID()}`;
    this.tokenExpiresAt = now + 30 * 60 * 1000;
    return { token: this.token, expiresAt: new Date(this.tokenExpiresAt).toISOString() };
  }

  async listGlobalAccounts(): Promise<GlobalAccount[]> {
    await this.login();
    return this.accounts.map((account) => ({ ...account }));
  }

  async createGlobalAccount(input: {
    request_id: string;
    country_code: string;
    nick_name?: string;
    required_features: Array<{ currency: string; transfer_method: "LOCAL" | "SWIFT" }>;
  }): Promise<GlobalAccount> {
    await this.login();
    const existing = this.accountCreates.get(input.request_id);
    if (existing) {
      if (!samePayload(existing.payload, input)) {
        throw new AirwallexError("request_id was already used for a different global account create", {
          status: 400,
          code: "duplicate_request_id",
        });
      }
      return { ...existing.account };
    }
    const account: GlobalAccount = {
      id: randomUUID(),
      status: "ACTIVE",
      country_code: input.country_code,
      nick_name: input.nick_name,
      request_id: input.request_id,
      required_features: input.required_features,
      supported_features: input.required_features.map((feature) => ({
        ...feature,
        type: "DEPOSIT",
        local_clearing_system: feature.transfer_method === "LOCAL" ? "ACH" : undefined,
      })),
    };
    this.accounts.push(account);
    this.accountCreates.set(input.request_id, { payload: input, account });
    const currency = input.required_features[0]?.currency;
    if (currency && !this.available.has(currency)) this.available.set(currency, 0);
    return { ...account };
  }

  async simulateDeposit(input: {
    global_account_id: string;
    amount: number;
    payer_name?: string;
    payer_country?: string;
    reference?: string;
  }): Promise<Deposit> {
    await this.login();
    const account = this.accounts.find((item) => item.id === input.global_account_id);
    if (!account) {
      throw new AirwallexError("Global account not found", { status: 400, code: "invalid_argument" });
    }
    const currency = account.required_features?.[0]?.currency ?? "USD";
    const amount = round2(input.amount);
    this.available.set(currency, round2((this.available.get(currency) ?? 0) + amount));
    return {
      id: randomUUID(),
      amount,
      currency,
      global_account_id: input.global_account_id,
      payer_name: input.payer_name,
      reference: input.reference,
      status: "PENDING",
    };
  }

  async getBalances(): Promise<Balance[]> {
    await this.login();
    const currencies = new Set(["USD", "EUR", "GBP", ...this.available.keys()]);
    return [...currencies].map((currency) => {
      const available = round2(this.available.get(currency) ?? 0);
      return {
        account_type: "cash",
        currency,
        available_amount: available,
        pending_amount: 0,
        reserved_amount: 0,
        prepayment_amount: 0,
        total_amount: available,
      };
    });
  }

  async getCurrentRate(input: {
    buy_currency: string;
    sell_currency: string;
    buy_amount?: number;
  }): Promise<FxRate> {
    await this.login();
    const rate = this.pairRate(input.buy_currency, input.sell_currency);
    const buyAmount = input.buy_amount ?? 10000;
    const sellAmount = round2(buyAmount * rate);
    return {
      buy_currency: input.buy_currency,
      sell_currency: input.sell_currency,
      buy_amount: buyAmount,
      sell_amount: sellAmount,
      rate,
      currency_pair: `${input.buy_currency}${input.sell_currency}`,
      rate_details: [{ level: "CLIENT", rate, buy_amount: buyAmount, sell_amount: sellAmount }],
    };
  }

  async createQuote(input: {
    buy_currency: string;
    sell_currency: string;
    buy_amount: number;
    validity: FxQuote["validity"];
  }): Promise<FxQuote> {
    await this.login();
    const rate = this.pairRate(input.buy_currency, input.sell_currency);
    const quote: StoredQuote = {
      quote_id: randomUUID(),
      buy_currency: input.buy_currency,
      sell_currency: input.sell_currency,
      buy_amount: round2(input.buy_amount),
      sell_amount: round2(input.buy_amount * rate),
      client_rate: rate,
      validity: input.validity,
      usage: "MULTI_USE",
      currency_pair: `${input.buy_currency}${input.sell_currency}`,
      used: false,
    };
    this.quotes.set(quote.quote_id, quote);
    const { used: _used, ...publicQuote } = quote;
    return publicQuote;
  }

  async createConversion(input: {
    request_id: string;
    buy_currency: string;
    sell_currency: string;
    buy_amount: string;
    quote_id: string;
  }): Promise<Conversion> {
    await this.login();
    const existing = this.conversions.get(input.request_id);
    if (existing) {
      throw new AirwallexError(`request_id ${input.request_id} has been used`, {
        status: 400,
        code: "invalid_argument",
        details: { request_id: input.request_id, conversion_id: existing.conversion.conversion_id },
      });
    }
    const quote = this.quotes.get(input.quote_id);
    if (!quote) {
      throw new AirwallexError("Unknown quote_id", { status: 400, code: "invalid_quote_id" });
    }
    if (quote.used) {
      throw new AirwallexError("FX quote is single-use and was already booked", {
        status: 400,
        code: "invalid_quote_id",
      });
    }
    if (quote.buy_currency !== input.buy_currency || quote.sell_currency !== input.sell_currency) {
      throw new AirwallexError("Conversion currencies must match the quote", {
        status: 400,
        code: "invalid_argument",
      });
    }
    const buyAmount = round2(Number(input.buy_amount));
    if (Math.abs(buyAmount - quote.buy_amount) > 0.001) {
      throw new AirwallexError("buy_amount must match the quote", { status: 400, code: "invalid_argument" });
    }
    const sellAmount = quote.sell_amount;
    const held = this.available.get(input.sell_currency) ?? 0;
    if (held + 0.001 < sellAmount) {
      throw new AirwallexError("Insufficient funds for conversion", { status: 400, code: "insufficient_funds" });
    }
    quote.used = true;
    this.available.set(input.sell_currency, round2(held - sellAmount));
    this.available.set(input.buy_currency, round2((this.available.get(input.buy_currency) ?? 0) + buyAmount));
    const conversion: Conversion = {
      conversion_id: randomUUID(),
      request_id: input.request_id,
      quote_id: input.quote_id,
      status: "SETTLED",
      buy_currency: input.buy_currency,
      sell_currency: input.sell_currency,
      buy_amount: amountString(buyAmount),
      sell_amount: amountString(sellAmount),
      client_rate: quote.client_rate,
    };
    this.conversions.set(input.request_id, { payload: input, conversion });
    return { ...conversion };
  }

  async beneficiarySchema(input: {
    account_currency: string;
    bank_country_code: string;
    entity_type: string;
    transfer_method: "LOCAL" | "SWIFT";
    local_clearing_system?: string;
  }): Promise<BeneficiarySchema> {
    await this.login();
    return {
      pathUsed: "/beneficiary_api_schemas/generate",
      fields: schemaFields(input),
      raw: { condition: input },
    };
  }

  async createBeneficiary(input: BeneficiaryPayload): Promise<Beneficiary> {
    await this.login();
    return { id: randomUUID(), ...input };
  }

  async createTransfer(input: {
    request_id: string;
    beneficiary_id: string;
    transfer_amount: string;
    transfer_currency: string;
    source_currency: string;
    transfer_method: "LOCAL" | "SWIFT";
    reason: string;
    reference: string;
    fee_paid_by?: "PAYER" | "BENEFICIARY";
  }): Promise<Transfer> {
    await this.login();
    if (input.request_id.length < 10 || input.request_id.length > 50) {
      throw new AirwallexError("request_id must be 10 to 50 characters", { status: 400, code: "018" });
    }
    const existing = this.transfers.get(input.request_id);
    if (existing) {
      throw new AirwallexError(
        `The request ID ${input.request_id} has been used for a transfer with the transfer ID ${existing.transfer.id} before.`,
        {
          status: 400,
          code: "duplicate_request_id",
          details: { id: existing.transfer.id, request_id: input.request_id },
        },
      );
    }
    const transferAmount = round2(Number(input.transfer_amount));
    const fee =
      input.transfer_method === "SWIFT" && input.transfer_currency === "EUR" ? resolveSwiftFee().base : 0;
    const feePaidBy = input.fee_paid_by ?? "PAYER";
    const payerPays = feePaidBy === "PAYER" ? round2(transferAmount + fee) : transferAmount;
    const beneficiaryReceives = feePaidBy === "PAYER" ? transferAmount : round2(transferAmount - fee);
    const held = this.available.get(input.source_currency) ?? 0;
    if (held + 0.001 < payerPays) {
      throw new AirwallexError("Insufficient balance for transfer", {
        status: 400,
        code: "balance_insufficient",
      });
    }
    this.available.set(input.source_currency, round2(held - payerPays));
    const transfer: Transfer = {
      id: randomUUID(),
      request_id: input.request_id,
      status: "SCHEDULED",
      transfer_amount: amountString(transferAmount),
      transfer_currency: input.transfer_currency,
      source_amount: amountString(payerPays),
      source_currency: input.source_currency,
      transfer_method: input.transfer_method,
      fee_amount: fee,
      fee_currency: input.source_currency,
      fee_paid_by: feePaidBy,
      amount_payer_pays: payerPays,
      amount_beneficiary_receives: beneficiaryReceives,
      beneficiary_id: input.beneficiary_id,
      reference: input.reference,
      reason: input.reason,
    };
    this.transfers.set(input.request_id, { payload: input, transfer });
    return { ...transfer };
  }

  async transitionTransfer(id: string, input: { next_status: string; failure_type?: string }): Promise<Transfer> {
    await this.login();
    const stored = [...this.transfers.values()].find((item) => item.transfer.id === id);
    if (!stored) throw new AirwallexError("Transfer not found", { status: 404, code: "not_found" });
    const current = stored.transfer.status ?? "PROCESSING";
    if (input.next_status === "PROCESSING") {
      throw new AirwallexError("operation_failed", { status: 500, code: "operation_failed" });
    }
    const allowed: Record<string, string[]> = {
      SCHEDULED: ["SENT", "FAILED", "CANCELLED"],
      PROCESSING: ["SENT", "FAILED", "CANCELLED", "OVERDUE"],
      SENT: ["PAID", "FAILED", "CANCELLED"],
    };
    if (current === input.next_status) return { ...stored.transfer };
    if (!(allowed[current] ?? []).includes(input.next_status)) {
      throw new AirwallexError(
        `Cannot move transfer from ${current} to ${input.next_status}. Simulate SENT before PAID.`,
        {
        status: 400,
        code: "invalid_status_transition",
      });
    }
    if (input.next_status === "FAILED" && !input.failure_type) {
      throw new AirwallexError("failure_type is required when next_status is FAILED", {
        status: 400,
        code: "invalid_argument",
      });
    }
    stored.transfer.status = input.next_status;
    if (input.failure_type) {
      stored.transfer.failure_type = input.failure_type;
      stored.transfer.failure_reason = input.failure_type;
    }
    return { ...stored.transfer };
  }

  async getTransfer(id: string): Promise<Transfer> {
    await this.login();
    const stored = [...this.transfers.values()].find((item) => item.transfer.id === id);
    if (!stored) throw new AirwallexError("Transfer not found", { status: 404, code: "not_found" });
    if (stored.transfer.status === "SCHEDULED") stored.transfer.status = "PROCESSING";
    return { ...stored.transfer };
  }

  async findTransferByRequestId(requestId: string): Promise<Transfer | null> {
    await this.login();
    const stored = this.transfers.get(requestId);
    return stored ? { ...stored.transfer } : null;
  }

  async findConversionByRequestId(requestId: string): Promise<Conversion | null> {
    await this.login();
    const stored = this.conversions.get(requestId);
    return stored ? { ...stored.conversion } : null;
  }

  private pairRate(buy: string, sell: string): number {
    const buyUsd = this.rates[buy];
    const sellUsd = this.rates[sell];
    if (!buyUsd || !sellUsd) {
      throw new AirwallexError(`Unsupported mock pair ${buy}/${sell}`, {
        status: 400,
        code: "unsupported_currency",
      });
    }
    return buyUsd / sellUsd;
  }
}
