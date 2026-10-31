export interface GlobalAccountFeature {
  currency?: string;
  transfer_method?: "LOCAL" | "SWIFT" | string;
  local_clearing_system?: string;
  type?: string;
}

export interface GlobalAccount {
  id: string;
  status?: string;
  country_code?: string;
  nick_name?: string;
  request_id?: string;
  required_features?: GlobalAccountFeature[];
  supported_features?: GlobalAccountFeature[];
}

export interface Balance {
  account_type?: string;
  available_amount?: number;
  pending_amount?: number;
  reserved_amount?: number;
  prepayment_amount?: number;
  total_amount?: number;
  currency?: string;
}

export interface Deposit {
  id?: string;
  amount?: number;
  currency?: string;
  global_account_id?: string;
  status?: string;
  payer_name?: string;
  reference?: string;
}

export interface FxRate {
  buy_currency: string;
  sell_currency: string;
  buy_amount?: number;
  sell_amount?: number;
  /** Indicative rate. Prefer rate_details[level=CLIENT].rate when present. */
  rate?: number;
  rate_details?: Array<{ level?: string; rate?: number; buy_amount?: number; sell_amount?: number }>;
  currency_pair?: string;
}

export interface FxQuote {
  quote_id: string;
  buy_currency: string;
  sell_currency: string;
  buy_amount: number;
  sell_amount: number;
  client_rate: number;
  validity?: string;
  usage?: string;
  currency_pair?: string;
}

export interface Conversion {
  conversion_id: string;
  request_id?: string;
  quote_id?: string;
  status?: string;
  buy_currency?: string;
  sell_currency?: string;
  buy_amount?: number | string;
  sell_amount?: number | string;
  client_rate?: number;
}

export interface SchemaField {
  key?: string;
  path?: string;
  required?: boolean;
}

export interface BeneficiarySchema {
  pathUsed: string;
  fields: SchemaField[];
  raw: unknown;
}

export interface BeneficiaryAddress {
  street_address?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country_code?: string;
}

export interface BeneficiaryBankDetails {
  account_currency?: string;
  account_name?: string;
  account_number?: string;
  account_routing_type1?: string;
  account_routing_value1?: string;
  bank_account_category?: string;
  bank_country_code?: string;
  bank_name?: string;
  iban?: string;
  swift_code?: string;
  local_clearing_system?: string;
}

export interface BeneficiaryPayload {
  beneficiary: {
    type?: string;
    entity_type?: "COMPANY" | "PERSONAL" | string;
    company_name?: string;
    first_name?: string;
    last_name?: string;
    address?: BeneficiaryAddress;
    bank_details?: BeneficiaryBankDetails;
  };
  transfer_methods: Array<"LOCAL" | "SWIFT" | string>;
  nickname?: string;
}

export interface Beneficiary extends BeneficiaryPayload {
  id: string;
}

export interface Transfer {
  id: string;
  request_id?: string;
  status?: string;
  transfer_amount?: number | string;
  transfer_currency?: string;
  source_amount?: number | string;
  source_currency?: string;
  transfer_method?: string;
  fee_amount?: number;
  fee_currency?: string;
  fee_paid_by?: string;
  amount_payer_pays?: number;
  amount_beneficiary_receives?: number;
  beneficiary_id?: string;
  reference?: string;
  reason?: string;
  failure_type?: string;
  failure_reason?: string;
}

export interface AirwallexClient {
  readonly mode: "mock" | "sandbox";
  reset?(): void;
  login(): Promise<{ token: string; expiresAt: string }>;
  listGlobalAccounts(): Promise<GlobalAccount[]>;
  createGlobalAccount(input: {
    request_id: string;
    country_code: string;
    nick_name?: string;
    required_features: Array<{ currency: string; transfer_method: "LOCAL" | "SWIFT" }>;
  }): Promise<GlobalAccount>;
  simulateDeposit(input: {
    global_account_id: string;
    amount: number;
    payer_name?: string;
    payer_country?: string;
    reference?: string;
  }): Promise<Deposit>;
  getBalances(): Promise<Balance[]>;
  getCurrentRate(input: {
    buy_currency: string;
    sell_currency: string;
    buy_amount?: number;
  }): Promise<FxRate>;
  createQuote(input: {
    buy_currency: string;
    sell_currency: string;
    buy_amount: number;
    validity: "MIN_1" | "MIN_15" | "MIN_30" | "HR_1" | "HR_4" | "HR_8" | "HR_24";
  }): Promise<FxQuote>;
  createConversion(input: {
    request_id: string;
    buy_currency: string;
    sell_currency: string;
    buy_amount: string;
    quote_id: string;
  }): Promise<Conversion>;
  beneficiarySchema(input: {
    account_currency: string;
    bank_country_code: string;
    entity_type: string;
    transfer_method: "LOCAL" | "SWIFT";
    local_clearing_system?: string;
  }): Promise<BeneficiarySchema>;
  createBeneficiary(input: BeneficiaryPayload): Promise<Beneficiary>;
  createTransfer(input: {
    request_id: string;
    beneficiary_id: string;
    transfer_amount: string;
    transfer_currency: string;
    source_currency: string;
    transfer_method: "LOCAL" | "SWIFT";
    reason: string;
    reference: string;
    fee_paid_by?: "PAYER" | "BENEFICIARY";
  }): Promise<Transfer>;
  transitionTransfer(
    id: string,
    input: { next_status: string; failure_type?: string },
  ): Promise<Transfer>;
  getTransfer(id: string): Promise<Transfer>;
  findTransferByRequestId(requestId: string): Promise<Transfer | null>;
  findConversionByRequestId(requestId: string): Promise<Conversion | null>;
}
