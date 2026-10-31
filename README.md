# Adaptive Treasury Controller

An agent that keeps multi-currency operating cash above a coded reserve floor while it settles a short book of invoices. **Airwallex is the payment rail** (Global Accounts, balances, FX, beneficiaries, and transfers). This repository is an independent hackathon project for Starter Kit 01 (Treasury & Ops). It is not an Airwallex product and there is no partnership.

The desk runs today with no API keys. When `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` are set, the same flow calls the [Airwallex sandbox](https://api.sandbox.airwallex.com/api/v1).

## Setup

Node.js 22 or newer.

```sh
node -v          # v22 or higher
npm install
cp .env.example .env
```

Leave the key fields empty for mock mode. Sandbox keys come from [sandbox.airwallex.com](https://sandbox.airwallex.com) → **Account → Developer → API keys**. Put them only in `.env`. That file is gitignored. `.env.example` has every variable and no secrets.

| Variable | Purpose |
| --- | --- |
| `AIRWALLEX_CLIENT_ID` | Sandbox client id. Empty with `TREASURY_MODE=auto` stays in mock mode. |
| `AIRWALLEX_API_KEY` | Sandbox API key. Same rule. |
| `AIRWALLEX_BASE_URL` | Defaults to `https://api.sandbox.airwallex.com`. |
| `TREASURY_MODE` | `auto` (default), `mock`, or `sandbox`. |
| `TREASURY_OPERATING_CAP` | Demo operating book, default `15500`. `off` uses the raw wallet. |
| `SWIFT_FEE_EUR` | EUR SWIFT fee estimate. Default `13.48` (observed sandbox fee). |
| `SWIFT_FEE_PAD_EUR` | Extra EUR bought so the conversion is not short. Default `1`. |
| `LLM_PROVIDER` | `auto`, `anthropic`, `openai`, or `none`. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Optional Claude explanations. |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | Optional OpenAI-compatible server. For Ollama: `http://127.0.0.1:11434/v1`, key `ollama`, model `llama3.1`. |
| `PORT` | Desk port, default `4317`. |

`x-api-version` is not sent. FX calls reject a stale version header, so the client leaves it off every request.

Mock, one shot, including a recorded approval:

```sh
npm run demo
```

The same path pauses for `y` before the conversion:

```sh
npm run demo:interactive
```

Web desk:

```sh
npm run serve
```

Open `http://localhost:4317` and press the acts in order. **Reset desk** clears the mock ledger. It does not reverse a sandbox deposit.

Sandbox: set both Airwallex variables in `.env` and leave `TREASURY_MODE=auto`. `npm run demo` and the desk then call the sandbox. Force the mock ledger even when keys are present with `TREASURY_MODE=mock`.

A fresh sandbox wallet is often credited with millions in USD, EUR, and GBP. There is no sandbox withdrawal or wallet-debit simulation (deposit simulation, direct-debit settle/reverse, and transfer-status simulation are the relevant sandbox calls). `TREASURY_OPERATING_CAP=15500` (the default) runs the floor math on a virtual operating book of that size, with EUR and GBP starting at zero, while quotes, conversions, and payouts still hit the live wallet. The desk labels this **sandbox demo cap** and also shows live USD. Set `TREASURY_OPERATING_CAP=off` only when the raw wallet is the book you want.

```sh
npm test
npm run typecheck
```

## What the demo shows

Five obligations across USD, EUR, and GBP fall due inside 72 hours. The controller:

1. Funds a critical shipping invoice from USD.
2. Converts the minimum USD into EUR for a time-sensitive supplier, including a SWIFT fee provision (observed sandbox fee plus a pad, not a hard-coded 12.85).
3. Defers the cheapest non-critical obligation while the whole book cannot be paid.
4. Escalates a metals invoice that would break the reserve floor.
5. Lowers forecast confidence when a customer email contradicts an expected receipt, and asks a person to approve the same EUR conversion.
6. After a simulated inbound deposit, recalculates and changes only the decision the new cash unlocks.
7. Books one FX quote (submitted once, even if the API marks it `MULTI_USE`), one conversion, and one supplier transfer, then shows that the operating book stays above the floor.

Policy (the floor, the confidence gate, the fee, and the approval band) lives in `src/policy/engine.ts`. A model may explain the plan. It cannot change an action. With no model key, a deterministic planner supplies the explanations and the demo still runs.

## Architecture

```mermaid
flowchart LR
  subgraph desk [Desk]
    Web[Web blotter]
    CLI[CLI demo]
  end
  Session[Treasury session]
  Policy[Policy engine]
  Planner[Planner]
  Client[Airwallex client]
  Web --> Session
  CLI --> Session
  Session --> Policy
  Session --> Planner
  Session --> Client
  Planner --> Deterministic[Deterministic fallback]
  Planner --> Anthropic[Anthropic]
  Planner --> OpenAI[OpenAI-compatible / Ollama]
  Client --> Mock[Mock ledger]
  Client --> Sandbox[Sandbox REST]
  Policy --> Actions[fund / convert / defer / escalate]
```

The session calls the banking client, then asks the planner for explanations, then keeps the coded action when they disagree. A repeated conversion or transfer `request_id` is resolved back to the resource Airwallex already created.

## Sandbox account

Sign up at [sandbox.airwallex.com](https://sandbox.airwallex.com). A personal email is fine. If you add another business, name it `New Business Sandbox` or `Sandbox Business` so sandbox onboarding can complete. In **Account → Developer → API keys**, create a key with read and write access and leave the IP allowlist empty. Do not commit the key.

## Demo script for a video under five minutes

Record the web desk in mock mode, or in sandbox if the wallet is near the opening target. Say what the numbers are; don't only read the chat.

| Time | Act | On screen | Say |
| --- | --- | --- | --- |
| 0:00 | Title | Mode badge says Mock ledger or Airwallex sandbox. Five unpaid rows. Floor is USD 8,000. | This is an operating-cash controller. Airwallex is the rail. The reserve floor is code, not a prompt. |
| 0:25 | 1 · Fund | USD available becomes 15,500. Deposit status can read PENDING while the balance is already there. | Fund the USD global account, then read balances before any decision. |
| 0:50 | 2 · Plan | Ship: fund. Rheinwerk: convert, no approval. Mesa: defer. Dockside: defer, cheapest. Nordhalle: escalate. Policy panel shows headroom, the confidence cap, and the SWIFT provision. | Critical freight is funded. The EUR supplier gets the minimum conversion, fee estimate plus pad. The cheapest retainer waits. The metals invoice would break the floor, so it is escalated. |
| 1:35 | 3 · Shock | The Cedar & Co. email appears. Confidence falls from 0.88 to 0.42. Rheinwerk flips to "Needs approval". Its action stays convert. | The email contradicts the USD 6,000 forecast. The gate drops the autonomous FX cap from 4,000 to 1,000, so this conversion now needs a person. |
| 2:15 | 4 · Recalc | USD 2,500 lands. Only Mesa Packaging changes, from defer to fund. Dockside and Nordhalle stay put. | New cash. Recalculate the affected row only. |
| 2:45 | Approve | The card names Rheinwerk, the EUR buy amount including the fee, and the estimated USD sell. Press **Approve this conversion**. | Approval is bound to that payee and those amounts. |
| 3:10 | 5 · Execute | Quote usage as returned (sandbox currently says MULTI_USE), conversion SETTLED, transfer PAID, operating USD still above 8,000. A small EUR pad can remain. USD freight stays queued. | One quote, submitted once. One supplier payout. The reserve floor still holds. |
| 4:10 | Audit | Scroll the log: schema path, request ids, policy overrides if a model disagreed. | The model can explain. It cannot move the money. |
| 4:30 | Close | `.env.example` in the repo, keys not in git. | Sandbox keys stay local. This is a hackathon demo, not a partnership and not live money. |

Skip any peer-session or chain handshake. It is not the payment rail and it is not in this build.

## Sandbox calls

Base URL `https://api.sandbox.airwallex.com/api/v1`. Amounts are major units.

| Step | Call |
| --- | --- |
| Auth | `POST /authentication/login` with `x-client-id` and `x-api-key`. Cache `token` until `expires_at`. |
| Accounts | `GET /global_accounts`. `POST /global_accounts/create` only when no USD local account exists. |
| Funding | `POST /simulation/deposit/create` with `global_account_id` and `amount`. No `currency` field. Poll `GET /balances/current` until the credit shows. |
| Rates | `GET /fx/rates/current` for an indicative rate. |
| Quote | `POST /fx/quotes/create` with `buy_currency`, `sell_currency`, `buy_amount`, and `validity`. Read `client_rate`, `sell_amount`, `quote_id`, and `usage`. |
| Conversion | `POST /fx/conversions/create` with `request_id`, currencies, `buy_amount`, and `quote_id`. |
| Beneficiary | Schema, then `POST /beneficiaries/create`, then `POST /transfers/create`. |
| Terminal status | Re-read the transfer, then `POST /simulation/transfers/{id}/transition` to SENT and then PAID. Do not simulate PROCESSING. |

The EUR beneficiary in the seed uses a well-known test IBAN and BIC with a synthetic company name. Sandbox validates the IBAN checksum. It is not a customer account.

## Doc ambiguities

Checked against the [hackathon builder guide](https://airwallexdev.com/guide), the public API reference, and the docs MCP at `https://mcp.sandbox.airwallex.com/docs`. No official Kit 01 source repository was found under an Airwallex organization; the guide is the kit. A community multi-kit desk exists elsewhere and was not used as the code base.

- The guide calls the schema endpoint `POST /beneficiaries/schema`. The API reference calls it `POST /beneficiary_api_schemas/generate`. Live sandbox: the guide path returns 200 with `{errors, schema}` and no `fields`; generate returns the field list. The client prefers generate and treats a 200 without `fields` as a miss.
- One FX guide example posts to `/api/v1/conversions/create`. The endpoint heading and the kit both say `POST /fx/conversions/create`. This client uses the `/fx/` path.
- Quote create has **no** `request_id`. The reference example shows `usage: SINGLE_USE`. Live sandbox quotes came back `MULTI_USE` for `MIN_1` and `MIN_30`. This run still submits each quote once. Idempotency for the booking is the conversion `request_id`.
- Reusing a conversion `request_id` returns `400 invalid_argument` ("has been used"). Reusing a transfer `request_id` returns `400 duplicate_request_id` with `details.id` set to the existing transfer. The client lists `GET /fx/conversions?request_id=` or `GET /transfers/{id}` and continues with that resource. It does not mint a second id.
- `GET /fx/rates/current` describes top-level `rate` in one place like a sell amount. The kit says to read `rate` as the indicative rate, and to read `client_rate` on a quote. The client prefers `rate_details` where `level` is `CLIENT`, then a top-level `rate` that looks like a price rather than a notional. The booked quote's `sell_amount` is what the floor check uses.
- A simulated deposit returns `PENDING`. The balance credit is asynchronous (about 0.5–3 seconds on the sandbox). The session polls for about five seconds.
- The kit's flat EUR 12.85 SWIFT fee does not match a live transfer, which returned `fee_amount` 13.48 (`amount_payer_pays` 1863.48 on an 1850 invoice). The client buys `SWIFT_FEE_EUR` (default 13.48) plus `SWIFT_FEE_PAD_EUR` (default 1) so an empty EUR balance is not short. The transfer's `fee_amount` is the amount that posted. Local payouts add nothing.
- `POST /beneficiaries/schema` can return HTTP 200 with `{errors, schema}` and no `fields` array. `POST /beneficiary_api_schemas/generate` returns the field list. A 200 without `fields` is treated as a miss. Generate's required `transfer_method` is not a field on `beneficiaries/create` (`transfer_methods` is). `beneficiary.type` must be `BANK_ACCOUNT`; `COMPANY` fails validation 016. `entity_type` stays `COMPANY`.
- A simulated deposit can return `201 PENDING` while the balance credit lands 0.5–3 seconds later. The session polls `GET /balances/current` for about five seconds.
- Sandbox wallets are often pre-funded near 10,000,000 in USD, EUR, and GBP. No withdrawal simulation was found in the API reference. The operating cap is the way the shortfall still binds.
- Transfer create can return `SCHEDULED` and a following GET shows `PROCESSING`. Simulating `PROCESSING` returns `500 operation_failed`. `SENT` then `PAID` succeed without `x-api-version`. The ladder re-reads status and does not simulate `PROCESSING`.
- `x-api-version` is omitted. Live `SENT` then `PAID` succeeded without that header. A stale header still returns `incorrect_version` on FX, so it stays off.
- Global-account list pagination fields were not fully specified in the retrieved pages. The client reads the first page (`items`, or a bare array). A normal sandbox account fits on one page.
- Transfer `request_id` length is described as 10–50 characters in the sandbox constraints and as up to 50 in one reference page. A UUID fits both.

## Layout

```
src/policy/engine.ts          reserve floor, confidence gate, fee, cheapest-defer rule
src/planner/planner.ts        Anthropic, OpenAI-compatible, deterministic fallback
src/airwallex/http-client.ts  sandbox REST and token cache
src/airwallex/mock-client.ts  same interface, no network
src/treasury/session.ts       the six acts
src/cli.ts                    demo and web server
public/                       judge-facing desk
tests/                        policy, mock flow, client shape
```

## License

MIT. Copyright 2026 Hobie Cunningham.
