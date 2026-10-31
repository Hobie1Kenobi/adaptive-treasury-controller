import { AirwallexError, isRouteMissing } from "./errors";
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
import { apiRoot } from "../env";
import { parseAirwallexTime } from "../money";

type FetchImpl = typeof fetch;

export class HttpAirwallexClient implements AirwallexClient {
  readonly mode = "sandbox" as const;
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly fetchImpl: FetchImpl = globalThis.fetch,
  ) {
    if (!env.AIRWALLEX_CLIENT_ID || !env.AIRWALLEX_API_KEY) {
      throw new Error("AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY are required for sandbox mode.");
    }
  }

  async login(): Promise<{ token: string; expiresAt: string }> {
    const now = Date.now();
    if (this.token && now < this.token.expiresAtMs - 60_000) {
      return { token: this.token.value, expiresAt: new Date(this.token.expiresAtMs).toISOString() };
    }
    const body = await this.request<{ token?: string; expires_at?: string }>("POST", "/authentication/login", {
      auth: false,
      body: undefined,
    });
    if (!body.token || !body.expires_at) {
      throw new AirwallexError("Login response did not include token and expires_at", {
        status: 502,
        code: "invalid_login_response",
        details: body,
      });
    }
    const expiresAtMs = parseAirwallexTime(body.expires_at);
    this.token = { value: body.token, expiresAtMs };
    return { token: body.token, expiresAt: body.expires_at };
  }

  async listGlobalAccounts(): Promise<GlobalAccount[]> {
    const body = await this.request<GlobalAccount[] | { items?: GlobalAccount[] }>("GET", "/global_accounts");
    if (Array.isArray(body)) return body;
    if (Array.isArray(body.items)) return body.items;
    throw new AirwallexError("Global account list did not include an items array", {
      status: 502,
      code: "unexpected_shape",
      details: body,
    });
  }

  async createGlobalAccount(input: {
    request_id: string;
    country_code: string;
    nick_name?: string;
    required_features: Array<{ currency: string; transfer_method: "LOCAL" | "SWIFT" }>;
  }): Promise<GlobalAccount> {
    return this.request("POST", "/global_accounts/create", { body: input });
  }

  async simulateDeposit(input: {
    global_account_id: string;
    amount: number;
    payer_name?: string;
    payer_country?: string;
    reference?: string;
  }): Promise<Deposit> {
    return this.request("POST", "/simulation/deposit/create", { body: input });
  }

  async getBalances(): Promise<Balance[]> {
    const body = await this.request<Balance[]>("GET", "/balances/current");
    if (!Array.isArray(body)) {
      throw new AirwallexError("Balance response was not an array", {
        status: 502,
        code: "unexpected_shape",
        details: body,
      });
    }
    return body;
  }

  async getCurrentRate(input: {
    buy_currency: string;
    sell_currency: string;
    buy_amount?: number;
  }): Promise<FxRate> {
    const params = new URLSearchParams({
      buy_currency: input.buy_currency,
      sell_currency: input.sell_currency,
    });
    if (input.buy_amount != null) params.set("buy_amount", String(input.buy_amount));
    return this.request("GET", `/fx/rates/current?${params.toString()}`);
  }

  async createQuote(input: {
    buy_currency: string;
    sell_currency: string;
    buy_amount: number;
    validity: "MIN_1" | "MIN_15" | "MIN_30" | "HR_1" | "HR_4" | "HR_8" | "HR_24";
  }): Promise<FxQuote> {
    const quote = await this.request<FxQuote>("POST", "/fx/quotes/create", { body: input });
    return {
      ...quote,
      buy_amount: Number(quote.buy_amount),
      sell_amount: Number(quote.sell_amount),
      client_rate: Number(quote.client_rate),
    };
  }

  async createConversion(input: {
    request_id: string;
    buy_currency: string;
    sell_currency: string;
    buy_amount: string;
    quote_id: string;
  }): Promise<Conversion> {
    return this.request("POST", "/fx/conversions/create", { body: input });
  }

  async beneficiarySchema(input: {
    account_currency: string;
    bank_country_code: string;
    entity_type: string;
    transfer_method: "LOCAL" | "SWIFT";
    local_clearing_system?: string;
  }): Promise<BeneficiarySchema> {
    // The hackathon guide names POST /beneficiaries/schema. The API reference
    // names POST /beneficiary_api_schemas/generate. Try the guide path, then
    // the documented path, and record which one answered.
    const paths = ["/beneficiaries/schema", "/beneficiary_api_schemas/generate"];
    let lastError: unknown;
    for (const path of paths) {
      try {
        const raw = await this.request<unknown>("POST", path, { body: input });
        return { pathUsed: path, fields: extractSchemaFields(raw), raw };
      } catch (error) {
        lastError = error;
        if (!isRouteMissing(error)) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Beneficiary schema request failed");
  }

  async createBeneficiary(input: BeneficiaryPayload): Promise<Beneficiary> {
    return this.request("POST", "/beneficiaries/create", { body: input });
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
    return this.request("POST", "/transfers/create", { body: input });
  }

  async transitionTransfer(id: string, input: { next_status: string; failure_type?: string }): Promise<Transfer> {
    return this.request("POST", `/simulation/transfers/${encodeURIComponent(id)}/transition`, { body: input });
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const auth = options.auth !== false;
    if (auth) {
      const session = await this.login();
      headers.Authorization = `Bearer ${session.token}`;
    } else {
      headers["x-client-id"] = this.env.AIRWALLEX_CLIENT_ID ?? "";
      headers["x-api-key"] = this.env.AIRWALLEX_API_KEY ?? "";
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    // FX calls reject a stale x-api-version. Leave the header off every call.
    const response = await this.fetchImpl(`${apiRoot(this.env)}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const parsed = text ? safeJson(text) : {};
    if (!response.ok) {
      const record = asRecord(parsed);
      const nested = asRecord(record?.error);
      const code = String(record?.code ?? nested?.code ?? `http_${response.status}`);
      const message = String(record?.message ?? nested?.message ?? response.statusText ?? "Airwallex request failed");
      throw new AirwallexError(message, { status: response.status, code, details: parsed });
    }
    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function extractSchemaFields(raw: unknown): SchemaField[] {
  const record = asRecord(raw);
  const fields = record?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter((field) => field && typeof field === "object") as SchemaField[];
}

export function missingRequiredFields(fields: SchemaField[], payload: unknown): string[] {
  const missing: string[] = [];
  for (const field of fields) {
    if (!field.required || !field.path) continue;
    const value = readDotPath(payload, field.path);
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) {
      missing.push(field.path);
    }
  }
  return missing;
}

function readDotPath(payload: unknown, path: string): unknown {
  let current: unknown = payload;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
