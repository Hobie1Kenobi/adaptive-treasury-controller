import { AirwallexError } from "./errors";
import type { AirwallexClient, Conversion, Transfer } from "./types";

export function isIdempotentReplay(error: unknown): boolean {
  if (!(error instanceof AirwallexError)) return false;
  if (error.code === "duplicate_request_id" || error.code === "request_id_duplicate") return true;
  return error.code === "invalid_argument" && /has been used|already been used/i.test(error.message);
}

export function priorTransferId(error: unknown): string | null {
  if (!(error instanceof AirwallexError)) return null;
  const body = asRecord(error.details);
  const details = asRecord(body?.details) ?? body;
  const id = details?.id ?? details?.transfer_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function createConversionRecovering(
  client: AirwallexClient,
  input: Parameters<AirwallexClient["createConversion"]>[0],
): Promise<Conversion> {
  try {
    return await client.createConversion(input);
  } catch (error) {
    if (!isIdempotentReplay(error)) throw error;
    const existing = await client.findConversionByRequestId(input.request_id);
    if (!existing) throw error;
    return existing;
  }
}

export async function createTransferRecovering(
  client: AirwallexClient,
  input: Parameters<AirwallexClient["createTransfer"]>[0],
): Promise<Transfer> {
  try {
    return await client.createTransfer(input);
  } catch (error) {
    if (!isIdempotentReplay(error)) throw error;
    const prior = priorTransferId(error);
    if (prior) {
      try {
        return await client.getTransfer(prior);
      } catch {
        // Fall through to the request_id lookup.
      }
    }
    const existing = await client.findTransferByRequestId(input.request_id);
    if (!existing) throw error;
    return existing;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
