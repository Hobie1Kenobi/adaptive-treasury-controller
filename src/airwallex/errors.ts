export class AirwallexError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, options: { status: number; code: string; details?: unknown }) {
    super(message);
    this.name = "AirwallexError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }
}

export function isRouteMissing(error: unknown): boolean {
  if (!(error instanceof AirwallexError)) return false;
  if (error.status === 404) return true;
  return error.code === "invalid_endpoint" || error.code === "not_found" || error.code === "404";
}
