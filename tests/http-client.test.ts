import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpAirwallexClient } from "../src/airwallex/http-client";
import { parseAirwallexTime } from "../src/money";

describe("sandbox client", () => {
  it("caches the bearer token, omits x-api-version, and falls back when the guide schema path is missing", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      const href = String(url);
      calls.push({ url: href, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : undefined });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (href.endsWith("/authentication/login")) {
        return json(201, { token: "tok_test", expires_at: "2030-01-01T00:00:00+0000" });
      }
      if (href.endsWith("/beneficiaries/schema")) return json(404, { code: "not_found", message: "no such route" });
      if (href.endsWith("/beneficiary_api_schemas/generate")) {
        return json(200, { fields: [{ path: "beneficiary.bank_details.iban", required: true, key: "iban" }] });
      }
      if (href.endsWith("/fx/quotes/create")) {
        return json(201, {
          quote_id: "q_1",
          buy_currency: "EUR",
          sell_currency: "USD",
          buy_amount: 10,
          sell_amount: 10.8,
          client_rate: 1.08,
          usage: "SINGLE_USE",
          validity: "MIN_30",
        });
      }
      return json(500, { message: `unexpected ${href}` });
    };

    const client = new HttpAirwallexClient(
      { AIRWALLEX_CLIENT_ID: "client_test", AIRWALLEX_API_KEY: "key_test", AIRWALLEX_BASE_URL: "https://api.sandbox.airwallex.com" },
      fetchImpl,
    );
    const schema = await client.beneficiarySchema({
      account_currency: "EUR",
      bank_country_code: "DE",
      entity_type: "COMPANY",
      transfer_method: "SWIFT",
    });
    assert.equal(schema.pathUsed, "/beneficiary_api_schemas/generate");
    assert.equal(schema.fields[0]?.path, "beneficiary.bank_details.iban");

    const quote = await client.createQuote({
      buy_currency: "EUR",
      sell_currency: "USD",
      buy_amount: 10,
      validity: "MIN_30",
    });
    assert.equal(quote.usage, "SINGLE_USE");
    assert.equal(quote.client_rate, 1.08);

    const login = calls.find((call) => call.url.endsWith("/authentication/login"));
    assert.ok(login);
    assert.equal(login.headers.get("x-client-id"), "client_test");
    assert.equal(login.headers.get("x-api-key"), "key_test");
    assert.equal(login.headers.get("authorization"), null);
    assert.equal(login.body, undefined);

    const quoteCall = calls.find((call) => call.url.endsWith("/fx/quotes/create"));
    assert.ok(quoteCall);
    assert.equal(quoteCall.headers.get("x-api-version"), null);
    assert.equal(quoteCall.headers.get("authorization"), "Bearer tok_test");
    assert.equal(quoteCall.headers.get("x-api-key"), null);
    const quoteBody = JSON.parse(quoteCall.body ?? "{}") as { request_id?: string; validity?: string; buy_amount?: number };
    assert.equal(quoteBody.request_id, undefined);
    assert.equal(quoteBody.validity, "MIN_30");
    assert.equal(quoteBody.buy_amount, 10);
    assert.equal(calls.filter((call) => call.url.endsWith("/authentication/login")).length, 1);
  });

  it("parses Airwallex expiry offsets", () => {
    assert.equal(Number.isNaN(parseAirwallexTime("2030-01-01T00:00:00+0000")), false);
  });
});
