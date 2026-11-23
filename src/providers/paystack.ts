import { getHeader, hmacHex, nowSeconds, parseKeyValueHeader, safeEqual, toBuffer } from "../crypto.js";
import type { VerifyInput, VerifyResult } from "../types.js";
import { asRecord, fail, parseJson, str } from "./shared.js";

export interface PaystackVerifyOptions {
  /**
   * Webhook signing secret (starts with `whsec_`) for the timestamped
   * `Paystack-Signature` header. The whole string, prefix included, is the HMAC key.
   * Pass several during rotation.
   */
  signingSecret?: string | string[];
  /**
   * Secret key (`sk_live_…` / `sk_test_…`) for the deprecated
   * `X-Paystack-Signature` header. Only checked when no `Paystack-Signature`
   * header is present, or when `allowLegacy` is true.
   */
  secretKey?: string;
  /**
   * Accept the deprecated `X-Paystack-Signature` header. Defaults to true when
   * `secretKey` is set. Set false once every Paystack integration sends the new header.
   */
  allowLegacy?: boolean;
  /** Maximum age, in seconds, of a `Paystack-Signature` timestamp. Default 300. */
  toleranceSeconds?: number;
  /** Override how the idempotency key is derived from the payload. */
  eventKey?: (payload: Record<string, unknown>) => string | undefined;
}

const PROVIDER = "paystack" as const;

/**
 * Paystack sends no event id, so the default key combines the event type with
 * the most stable id in `data`: `data.id`, then `data.reference`, then
 * `data.transfer_code`/`data.subscription_code`/`data.code`.
 */
export function defaultPaystackEventKey(payload: Record<string, unknown>): string | undefined {
  const event = str(payload.event);
  const data = asRecord(payload.data);
  const id =
    str(data.id) ??
    str(data.reference) ??
    str(data.transfer_code) ??
    str(data.subscription_code) ??
    str(data.code);
  if (!event || !id) return undefined;
  return `${event}:${id}`;
}

function secretsOf(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter((s) => s.length > 0);
}

export function verifyPaystack(input: VerifyInput, options: PaystackVerifyOptions): VerifyResult {
  let raw: Buffer;
  try {
    raw = toBuffer(input.rawBody);
  } catch (err) {
    return fail(PROVIDER, "invalid_body", (err as Error).message);
  }

  const signingSecrets = secretsOf(options.signingSecret);
  const allowLegacy = options.allowLegacy ?? Boolean(options.secretKey);
  if (signingSecrets.length === 0 && !(allowLegacy && options.secretKey)) {
    return fail(PROVIDER, "no_secret_configured", "Configure signingSecret (whsec_…) or secretKey.");
  }

  const timestamped = getHeader(input.headers, "paystack-signature");
  const legacy = getHeader(input.headers, "x-paystack-signature");
  let scheme: string | undefined;

  if (timestamped !== undefined && signingSecrets.length > 0) {
    const parts = parseKeyValueHeader(timestamped);
    const t = parts.get("t")?.[0];
    const v1 = parts.get("v1") ?? [];
    if (!t || !/^\d+$/.test(t) || v1.length === 0) {
      return fail(PROVIDER, "malformed_signature", "Paystack-Signature must contain t=<unix seconds> and v1=<key id>:<hex>.");
    }
    const tolerance = options.toleranceSeconds ?? 300;
    const now = input.now ?? nowSeconds();
    if (Math.abs(now - Number(t)) > tolerance) {
      return fail(PROVIDER, "timestamp_outside_tolerance", `Signature timestamp is more than ${tolerance}s from now.`);
    }
    const signed = Buffer.concat([Buffer.from(`${t}.`, "utf8"), raw]);
    const expected = signingSecrets.map((secret) => hmacHex("sha512", secret, signed));
    let matched = false;
    for (const entry of v1) {
      // v1=<key id>:<hex>. Accept a bare hex too, in case no key id is sent.
      const colon = entry.lastIndexOf(":");
      const hex = (colon >= 0 ? entry.slice(colon + 1) : entry).toLowerCase();
      for (const exp of expected) {
        if (safeEqual(hex, exp)) matched = true;
      }
    }
    if (!matched) return fail(PROVIDER, "signature_mismatch", "No v1 entry in Paystack-Signature matched.");
    scheme = "paystack-signature";
  } else if (legacy !== undefined && allowLegacy && options.secretKey) {
    const expected = hmacHex("sha512", options.secretKey, raw);
    if (!safeEqual(legacy.trim().toLowerCase(), expected)) {
      return fail(PROVIDER, "signature_mismatch", "X-Paystack-Signature did not match.");
    }
    scheme = "x-paystack-signature";
  } else {
    return fail(PROVIDER, "missing_signature", "No Paystack signature header that the configured secrets can check.");
  }

  const parsed = parseJson(raw);
  if (!parsed.ok) return fail(PROVIDER, "invalid_json", "Body is not valid JSON.");
  const payload = asRecord(parsed.value);
  const eventKey = (options.eventKey ?? defaultPaystackEventKey)(payload);
  if (!eventKey) return fail(PROVIDER, "invalid_json", "Could not derive an event key from the payload.");
  return { ok: true, provider: PROVIDER, eventKey, eventType: str(payload.event) ?? "unknown", payload, scheme };
}
