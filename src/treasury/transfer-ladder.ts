import { AirwallexError } from "../airwallex/errors";
import type { AirwallexClient, Transfer } from "../airwallex/types";

const RANK = ["NEW", "SCHEDULED", "PENDING", "IN_APPROVAL", "PROCESSING", "SENT", "PAID"];

function rankOf(status: string): number {
  const index = RANK.indexOf(status);
  return index === -1 ? -1 : index;
}

export async function advanceTransferToPaid(
  client: Pick<AirwallexClient, "getTransfer" | "transitionTransfer">,
  transfer: Transfer,
): Promise<string> {
  let status = transfer.status ?? "PROCESSING";
  const fresh = await client.getTransfer(transfer.id);
  status = fresh.status ?? status;
  for (const step of ["SENT", "PAID"] as const) {
    if (status === "PAID") break;
    if (rankOf(status) >= rankOf(step)) continue;
    try {
      const updated = await client.transitionTransfer(transfer.id, { next_status: step });
      status = updated.status ?? step;
    } catch (error) {
      if (error instanceof AirwallexError && (error.code === "operation_failed" || error.status === 500)) {
        const again = await client.getTransfer(transfer.id);
        status = again.status ?? status;
        if (rankOf(status) >= rankOf(step)) continue;
      }
      throw error;
    }
  }
  return status;
}
