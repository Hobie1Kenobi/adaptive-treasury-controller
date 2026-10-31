import type { BeneficiaryPayload } from "../airwallex/types";

export type ObligationCurrency = "USD" | "EUR" | "GBP";

export interface Obligation {
  id: string;
  payee: string;
  description: string;
  amount: number;
  currency: ObligationCurrency;
  transferMethod: "LOCAL" | "SWIFT";
  dueInHours: number;
  critical: boolean;
  reason: string;
  beneficiary?: BeneficiaryPayload;
  schema: {
    bank_country_code: string;
    entity_type: "COMPANY";
    transfer_method: "LOCAL" | "SWIFT";
    local_clearing_system?: string;
  };
}

export const FORECAST = {
  invoice: "AF-4418",
  payer: "Cedar & Co.",
  amount: 6000,
  currency: "USD" as const,
  expectedInHours: 36,
  supportedNote: "Open invoice AF-4418 matches the amount Cedar & Co. confirmed on Monday.",
};

export const CONFLICTING_EMAIL = {
  from: "Casey Nguyen <casey@cedarandco.example>",
  subject: "Re: Invoice AF-4418 — please hold",
  body: "We will not remit the $6,000 this week. The shipment count on AF-4418 does not match our receiving report, and accounts payable has pushed this to next month's cycle. Do not treat that receipt as committed cash.",
};

const rheinwerkBeneficiary: BeneficiaryPayload = {
  nickname: "Rheinwerk Components GmbH",
  transfer_methods: ["SWIFT"],
  beneficiary: {
    entity_type: "COMPANY",
    company_name: "Rheinwerk Components GmbH",
    address: {
      street_address: "Speicherstrasse 18",
      city: "Hamburg",
      postcode: "20457",
      country_code: "DE",
    },
    bank_details: {
      account_currency: "EUR",
      account_name: "Rheinwerk Components GmbH",
      bank_country_code: "DE",
      iban: "DE89370400440532013000",
      swift_code: "DEUTDEFF",
    },
  },
};

/** Five obligations, three currencies, due inside a 72-hour window. */
export const OBLIGATIONS: Obligation[] = [
  {
    id: "INV-SHIP-1042",
    payee: "Pacific Lane Logistics",
    description: "Ocean freight. Unpaid, outbound orders stop.",
    amount: 4200,
    currency: "USD",
    transferMethod: "LOCAL",
    dueInHours: 8,
    critical: true,
    reason: "freight",
    schema: { bank_country_code: "US", entity_type: "COMPANY", transfer_method: "LOCAL", local_clearing_system: "ACH" },
  },
  {
    id: "INV-EUR-220",
    payee: "Rheinwerk Components GmbH",
    description: "Time-sensitive parts. EUR SWIFT, fee included in the conversion.",
    amount: 1850,
    currency: "EUR",
    transferMethod: "SWIFT",
    dueInHours: 20,
    critical: false,
    reason: "goods_purchased",
    beneficiary: rheinwerkBeneficiary,
    schema: { bank_country_code: "DE", entity_type: "COMPANY", transfer_method: "SWIFT" },
  },
  {
    id: "INV-EUR-901",
    payee: "Nordhalle Metals AG",
    description: "Bulk metal buy. Funding it would break the reserve floor.",
    amount: 9400,
    currency: "EUR",
    transferMethod: "SWIFT",
    dueInHours: 36,
    critical: false,
    reason: "goods_purchased",
    schema: { bank_country_code: "DE", entity_type: "COMPANY", transfer_method: "SWIFT" },
  },
  {
    id: "INV-USD-317",
    payee: "Mesa Packaging Co.",
    description: "Cartons for next week's shipments.",
    amount: 1500,
    currency: "USD",
    transferMethod: "LOCAL",
    dueInHours: 40,
    critical: false,
    reason: "goods_purchased",
    schema: { bank_country_code: "US", entity_type: "COMPANY", transfer_method: "LOCAL", local_clearing_system: "ACH" },
  },
  {
    id: "INV-GBP-088",
    payee: "Dockside Studio Ltd",
    description: "Catalog photography retainer. Cheapest item on the blotter.",
    amount: 420,
    currency: "GBP",
    transferMethod: "LOCAL",
    dueInHours: 64,
    critical: false,
    reason: "professional_business_services",
    schema: { bank_country_code: "GB", entity_type: "COMPANY", transfer_method: "LOCAL" },
  },
];

export function obligationById(id: string): Obligation {
  const found = OBLIGATIONS.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown obligation ${id}`);
  return found;
}
