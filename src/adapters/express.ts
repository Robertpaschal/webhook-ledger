import { isRawBody } from "../crypto.js";
import { handleWebhook, type WebhookConfig } from "../handle.js";
import type { HeaderBag, RawBody } from "../types.js";

interface ExpressLikeRequest {
  body?: unknown;
  headers: HeaderBag;
}
interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  json(body: unknown): unknown;
}
type Next = (err?: unknown) => void;

/**
 * Express (4 or 5) handler. Mount it behind `express.raw({ type: "*\/*" })`
 * so `req.body` is the untouched Buffer:
 *
 *   app.post("/webhooks/paystack", express.raw({ type: "*\/*" }), expressWebhook({ ... }))
 *
 * If `express.json()` already ran, the raw bytes are gone and verification
 * cannot be done safely; the handler answers 500 and says why instead of
 * re-serialising the object.
 */
export function expressWebhook<T = unknown>(config: WebhookConfig<T>) {
  return async (req: ExpressLikeRequest, res: ExpressLikeResponse, next: Next): Promise<void> => {
    if (!isRawBody(req.body)) {
      res.status(500).json({
        ok: false,
        status: "misconfigured",
        reason: "raw_body_unavailable: mount express.raw({ type: '*/*' }) on this route before the webhook handler",
      });
      return;
    }
    try {
      const out = await handleWebhook(config, req.body as RawBody, req.headers);
      res.status(out.statusCode).json(out.body);
    } catch (err) {
      next(err);
    }
  };
}
