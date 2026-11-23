import { getHeader, safeEqual, toBuffer } from "../crypto.js";
import type { VerifyInput, VerifyResult } from "../types.js";
import { asRecord, fail, parseJson, str } from "./shared.js";

export interface FlutterwaveVerifyOptions {
  /** The secret hash set in the Flutterwave dashboard (Settings → Webhooks). */
  secretHash: string;
  eventKey?: (payload: Record<string, unknown>) => string | undefined;
}

const PROVIDER = "flutterwave" as const;

/** `event` plus `data.id`, falling back to `data.tx_ref` / `data.flw_ref`. */
export function defaultFlutterwaveEventKey(payload: Record<string, unknown>): string | undefined {
  const event = str(payload.event) ?? str(payload["event.type"]) ?? str(payload.type);
  const data = asRecord(payload.data);
  const id = str(data.id) ?? str(data.tx_ref) ?? str(data.flw_ref) ?? str(payload.id);
  if (!event || !id) return undefined;
  return `${event}:${id}`;
}

/**
 * Flutterwave sends the dashboard secret hash, unchanged, in `verif-hash`.
 * This is a shared secret, not a signature over the body: it proves the
 * sender knows the hash, not that the body is untampered. Pair it with
 * re-fetching the transaction from Flutterwave before giving value (the
 * reconciliation CLI does this in bulk).
 */
export function verifyFlutterwave(input: VerifyInput, options: FlutterwaveVerifyOptions): VerifyResult {
  let raw: Buffer;
  try {
    raw = toBuffer(input.rawBody);
  } catch (err) {
    return fail(PROVIDER, "invalid_body", (err as Error).message);
  }
  if (!options.secretHash) return fail(PROVIDER, "no_secret_configured", "Configure secretHash.");
  const header = getHeader(input.headers, "verif-hash");
  if (header === undefined) return fail(PROVIDER, "missing_signature", "Missing verif-hash header.");
  if (!safeEqual(header, options.secretHash)) {
    return fail(PROVIDER, "signature_mismatch", "verif-hash did not match the configured secret hash.");
  }
  const parsed = parseJson(raw);
  if (!parsed.ok) return fail(PROVIDER, "invalid_json", "Body is not valid JSON.");
  const payload = asRecord(parsed.value);
  const eventKey = (options.eventKey ?? defaultFlutterwaveEventKey)(payload);
  if (!eventKey) return fail(PROVIDER, "invalid_json", "Could not derive an event key from the payload.");
  const eventType = str(payload.event) ?? str(payload["event.type"]) ?? str(payload.type) ?? "unknown";
  return { ok: true, provider: PROVIDER, eventKey, eventType, payload, scheme: "verif-hash" };
}
