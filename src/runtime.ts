import { createClient } from "./airwallex";
import { loadDotEnv, resolveMode } from "./env";
import { createPlanner } from "./planner/planner";
import { TreasurySession } from "./treasury/session";

export function buildSession(): TreasurySession {
  loadDotEnv();
  const mode = resolveMode();
  const planner = createPlanner();
  return new TreasurySession(createClient(), planner);
}

export function describeRuntime(): { mode: string; planner: string } {
  loadDotEnv();
  const planner = createPlanner();
  return { mode: resolveMode(), planner: planner.label };
}
