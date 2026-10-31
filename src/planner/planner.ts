import type { PolicyDecision, PolicySnapshot, TreasuryAction } from "../policy/engine";
import type { Obligation } from "../scenario/seed";

export interface LlmDecision {
  obligationId: string;
  action: TreasuryAction;
  explanation: string;
}

export interface LlmProposal {
  summary: string;
  decisions: LlmDecision[];
}

export interface PlannerContext {
  obligations: Obligation[];
  decisions: PolicyDecision[];
  snapshot: PolicySnapshot;
  emailBody: string | null;
  forecastNote: string;
}

export interface Planner {
  readonly id: string;
  readonly label: string;
  propose(context: PlannerContext): Promise<LlmProposal | null>;
}

const ACTIONS = new Set<TreasuryAction>(["fund", "convert", "defer", "escalate"]);

export class DeterministicPlanner implements Planner {
  readonly id = "deterministic";
  readonly label = "Deterministic fallback (no model call)";
  async propose(): Promise<null> {
    return null;
  }
}

export function createPlanner(env: NodeJS.ProcessEnv = process.env): Planner {
  const choice = (env.LLM_PROVIDER ?? "auto").trim().toLowerCase();
  if (choice === "none" || choice === "deterministic") return new DeterministicPlanner();
  if (choice === "anthropic") return new AnthropicPlanner(env);
  if (choice === "openai") return new OpenAiCompatiblePlanner(env);
  if (choice !== "auto") {
    throw new Error(`Unknown LLM_PROVIDER "${choice}". Use auto, anthropic, openai, or none.`);
  }
  if (env.ANTHROPIC_API_KEY) return new AnthropicPlanner(env);
  if (env.OPENAI_BASE_URL) return new OpenAiCompatiblePlanner(env);
  return new DeterministicPlanner();
}

export function parseProposal(text: string): LlmProposal | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced?.[1] ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1)) as {
      summary?: unknown;
      decisions?: unknown;
    };
    if (!Array.isArray(parsed.decisions)) return null;
    const decisions: LlmDecision[] = [];
    for (const item of parsed.decisions) {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const action = record.action;
      if (typeof record.obligationId !== "string" || typeof action !== "string" || !ACTIONS.has(action as TreasuryAction)) {
        return null;
      }
      decisions.push({
        obligationId: record.obligationId,
        action: action as TreasuryAction,
        explanation: typeof record.explanation === "string" ? record.explanation : "",
      });
    }
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      decisions,
    };
  } catch {
    return null;
  }
}

function prompt(context: PlannerContext): string {
  const lines = context.decisions.map(
    (decision) =>
      `- ${decision.obligationId} ${decision.payee}: policy action=${decision.action}, usdCost=${decision.usdCost}, needsApproval=${decision.needsApproval}. Policy explanation: ${decision.explanation}`,
  );
  return [
    "You are explaining a treasury plan. You do not decide it.",
    "The policy engine already chose fund, convert, defer, or escalate for each obligation.",
    "Return JSON only: {\"summary\": string, \"decisions\": [{\"obligationId\": string, \"action\": \"fund\"|\"convert\"|\"defer\"|\"escalate\", \"explanation\": string}]}.",
    "Repeat the policy action exactly. A different action is discarded.",
    "One or two sentences per explanation. Mention the reserve floor, the fee, or the confidence gate when they apply.",
    `Reserve floor USD ${context.snapshot.reserveFloorUsd}. Available USD ${context.snapshot.usdAvailable}. Confidence ${context.snapshot.confidence}. Autonomous FX cap USD ${context.snapshot.autonomousCapUsd}.`,
    `Forecast: ${context.forecastNote}`,
    context.emailBody ? `Customer email: ${context.emailBody}` : "No conflicting customer email is on file.",
    "Coded decisions:",
    ...lines,
  ].join("\n");
}

class AnthropicPlanner implements Planner {
  readonly id = "anthropic";
  readonly label: string;
  constructor(private readonly env: NodeJS.ProcessEnv) {
    this.label = `Anthropic (${env.ANTHROPIC_MODEL || "claude-sonnet-4-5"})`;
  }
  async propose(context: PlannerContext): Promise<LlmProposal | null> {
    if (!this.env.ANTHROPIC_API_KEY) return null;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt(context) }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Anthropic request failed (${response.status})`);
    }
    const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (body.content ?? []).map((block) => block.text ?? "").join("\n");
    return parseProposal(text);
  }
}

class OpenAiCompatiblePlanner implements Planner {
  readonly id = "openai";
  readonly label: string;
  constructor(private readonly env: NodeJS.ProcessEnv) {
    const model = env.OPENAI_MODEL || "llama3.1";
    this.label = `OpenAI-compatible (${model})`;
  }
  async propose(context: PlannerContext): Promise<LlmProposal | null> {
    const base = (this.env.OPENAI_BASE_URL ?? "").replace(/\/$/, "");
    if (!base) return null;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.env.OPENAI_API_KEY) headers.Authorization = `Bearer ${this.env.OPENAI_API_KEY}`;
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.env.OPENAI_MODEL || "llama3.1",
        temperature: 0,
        messages: [
          { role: "system", content: "You explain treasury decisions. Return JSON only." },
          { role: "user", content: prompt(context) },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI-compatible request failed (${response.status})`);
    }
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content ?? "";
    return parseProposal(text);
  }
}
