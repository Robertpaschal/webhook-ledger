export type Provider = "paystack" | "flutterwave" | "stripe";

/** Header map as Node, Express and Fastify expose it. Keys are matched case-insensitively. */
export type HeaderBag = Record<string, string | string[] | undefined>;

/** The raw request body, exactly as received. Never a re-serialised JSON object. */
export type RawBody = Buffer | Uint8Array | string;

export interface VerifiedEvent<T = unknown> {
  ok: true;
  provider: Provider;
  /** Stable key for idempotency. Unique per provider. */
  eventKey: string;
  /** Provider event type, e.g. "charge.success", "payment_intent.succeeded". */
  eventType: string;
  /** Parsed JSON payload. */
  payload: T;
  /** Which signature scheme matched. */
  scheme: string;
}

export type VerifyFailureReason =
  | "missing_signature"
  | "malformed_signature"
  | "signature_mismatch"
  | "timestamp_outside_tolerance"
  | "no_secret_configured"
  | "invalid_body"
  | "invalid_json";

export interface VerifyFailure {
  ok: false;
  provider: Provider;
  reason: VerifyFailureReason;
  /** Human-readable detail. Never contains secrets or signature values. */
  message: string;
}

export type VerifyResult<T = unknown> = VerifiedEvent<T> | VerifyFailure;

export interface VerifyInput {
  rawBody: RawBody;
  headers: HeaderBag;
  /** Override "now" (unix seconds) for testing. */
  now?: number;
}
