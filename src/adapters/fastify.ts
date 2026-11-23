import { handleWebhook, type WebhookConfig } from "../handle.js";
import type { HeaderBag, RawBody } from "../types.js";

// Structural types so this package does not depend on fastify at runtime or in its typings.
interface FastifyLikeInstance {
  removeAllContentTypeParsers(): void;
  addContentTypeParser(
    contentType: string | string[],
    opts: { parseAs: "buffer"; bodyLimit?: number },
    parser: (req: unknown, body: Buffer, done: (err: Error | null, body?: unknown) => void) => void,
  ): void;
  post(path: string, handler: (req: { body: unknown; headers: HeaderBag }, reply: FastifyLikeReply) => Promise<unknown>): void;
}
interface FastifyLikeReply {
  code(statusCode: number): FastifyLikeReply;
  send(payload: unknown): unknown;
}

export type FastifyWebhookOptions<T = unknown> = WebhookConfig<T> & {
  /** Route path, e.g. "/webhooks/stripe". */
  path: string;
  bodyLimit?: number;
};

/**
 * Fastify (4 or 5) plugin. Register it in its own encapsulated context so the
 * raw-buffer body parser only applies to the webhook route:
 *
 *   await app.register(fastifyWebhook, { path: "/webhooks/stripe", provider: "stripe", ... })
 */
export async function fastifyWebhook<T = unknown>(app: FastifyLikeInstance, options: FastifyWebhookOptions<T>): Promise<void> {
  // Fastify's default JSON parser would consume the bytes we need to verify.
  // This only affects the plugin's own encapsulated context.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: options.bodyLimit }, (_req, body, done) => {
    done(null, body);
  });
  app.post(options.path, async (req, reply) => {
    const out = await handleWebhook(options, req.body as RawBody, req.headers);
    return reply.code(out.statusCode).send(out.body);
  });
}
