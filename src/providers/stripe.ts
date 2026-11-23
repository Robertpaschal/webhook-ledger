import { getHeader, hmacHex, nowSeconds, parseKeyValueHeader, safeEqual, toBuffer } from "../crypto.js";
import type { VerifyInput, VerifyResult } from "../types.js";
import { asRecord, fail, parseJson, str } from "./shared.js";

export interface StripeVerifyOptions {
  /** Endpoint signing secret (`whsec_…`). Pass several during rotation. */
  signingSecret: string | string[];
  /** Maximum signature age in seconds. Default 300, matching Stripe's libraries. */
  toleranceSeconds?: number;
  eventKey?: (payload: Record<string, unknown>) => string | undefined;
}

const PROVIDER = "stripe" as const;

export function defaultStripeEventKey(payload: Record<string, unknown>): string | undefined {
  return str(payload.id);
}

/**
 * Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>][,v0=…]
 * Signed payload: "<t>.<raw body>", HMAC-SHA256, keyed with the full whsec_ string.
 * Only v1 is checked; v0 is a test-mode legacy scheme and is ignored.
 */
export function verifyStripe(input: VerifyInput, options: StripeVerifyOptions): VerifyResult {
  let raw: Buffer;
  try {
    raw = toBuffer(input.rawBody);
  } catch (err) {
    return fail(PROVIDER, "invalid_body", (err as Error).message);
  }
  const secrets = (Array.isArray(options.signingSecret) ? options.signingSecret : [options.signingSecret]).filter(
    (s) => typeof s === "string" && s.length > 0,
  );
  if (secrets.length === 0) return fail(PROVIDER, "no_secret_configured", "Configure signingSecret (whsec_…).");

  const header = getHeader(input.headers, "stripe-signature");
  if (header === undefined) return fail(PROVIDER, "missing_signature", "Missing Stripe-Signature header.");
  const parts = parseKeyValueHeader(header);
  const t = parts.get("t")?.[0];
  const v1 = parts.get("v1") ?? [];
  if (!t || !/^\d+$/.test(t) || v1.length === 0) {
    return fail(PROVIDER, "malformed_signature", "Stripe-Signature must contain t=<unix seconds> and v1=<hex>.");
  }
  const tolerance = options.toleranceSeconds ?? 300;
  const now = input.now ?? nowSeconds();
  if (Math.abs(now - Number(t)) > tolerance) {
    return fail(PROVIDER, "timestamp_outside_tolerance", `Signature timestamp is more than ${tolerance}s from now.`);
  }
  const signed = Buffer.concat([Buffer.from(`${t}.`, "utf8"), raw]);
  const expected = secrets.map((s) => hmacHex("sha256", s, signed));
  let matched = false;
  for (const sig of v1) {
    for (const exp of expected) {
      if (safeEqual(sig.toLowerCase(), exp)) matched = true;
    }
  }
  if (!matched) return fail(PROVIDER, "signature_mismatch", "No v1 signature in Stripe-Signature matched.");

  const parsed = parseJson(raw);
  if (!parsed.ok) return fail(PROVIDER, "invalid_json", "Body is not valid JSON.");
  const payload = asRecord(parsed.value);
  const eventKey = (options.eventKey ?? defaultStripeEventKey)(payload);
  if (!eventKey) return fail(PROVIDER, "invalid_json", "Payload has no event id.");
  return { ok: true, provider: PROVIDER, eventKey, eventType: str(payload.type) ?? "unknown", payload, scheme: "stripe-signature" };
}
