import { verifyFlutterwave, type FlutterwaveVerifyOptions } from "./providers/flutterwave.js";
import { verifyPaystack, type PaystackVerifyOptions } from "./providers/paystack.js";
import { verifyStripe, type StripeVerifyOptions } from "./providers/stripe.js";
import type { EventHandler, Ledger, ProcessOutcome } from "./ledger/ledger.js";
import type { HeaderBag, RawBody, VerifyInput, VerifyResult } from "./types.js";

export type ProviderConfig =
  | { provider: "paystack"; options: PaystackVerifyOptions }
  | { provider: "flutterwave"; options: FlutterwaveVerifyOptions }
  | { provider: "stripe"; options: StripeVerifyOptions };

export function verifyWebhook(config: ProviderConfig, input: VerifyInput): VerifyResult {
  switch (config.provider) {
    case "paystack":
      return verifyPaystack(input, config.options);
    case "flutterwave":
      return verifyFlutterwave(input, config.options);
    case "stripe":
      return verifyStripe(input, config.options);
  }
}

export type WebhookConfig<T = unknown> = ProviderConfig & {
  ledger: Ledger;
  handler: EventHandler<T>;
  /** Called with every outcome, including rejected signatures. Use it for logs and metrics. */
  onOutcome?: (outcome: HandleOutcome) => void;
};

export type HandleOutcome =
  | { kind: "rejected"; verify: Exclude<VerifyResult, { ok: true }> }
  | { kind: "ledger"; result: ProcessOutcome };

export interface HttpResponse {
  statusCode: number;
  body: { ok: boolean; status: string; reason?: string };
}

/**
 * Framework-agnostic request handling: verify, then process once.
 *
 * - bad or missing signature → 401 (no ledger row is written)
 * - unparseable body → 400
 * - processed or duplicate → 200 (a duplicate must be acknowledged so the provider stops retrying)
 * - handler threw → 500, so the provider retries
 */
export async function handleWebhook<T>(config: WebhookConfig<T>, rawBody: RawBody, headers: HeaderBag): Promise<HttpResponse> {
  const verified = verifyWebhook(config, { rawBody, headers });
  if (!verified.ok) {
    config.onOutcome?.({ kind: "rejected", verify: verified });
    const client = verified.reason === "invalid_body" || verified.reason === "invalid_json";
    const misconfigured = verified.reason === "no_secret_configured";
    return {
      statusCode: misconfigured ? 500 : client ? 400 : 401,
      body: { ok: false, status: "rejected", reason: verified.reason },
    };
  }
  const result = await config.ledger.process(verified as typeof verified & { payload: T }, config.handler);
  config.onOutcome?.({ kind: "ledger", result });
  if (result.status === "failed") return { statusCode: 500, body: { ok: false, status: "failed" } };
  return { statusCode: 200, body: { ok: true, status: result.status } };
}
