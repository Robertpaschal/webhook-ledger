import { createHmac, timingSafeEqual } from "node:crypto";
import type { HeaderBag, RawBody } from "./types.js";

export function toBuffer(body: RawBody): Buffer {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError(
    "webhook-ledger: rawBody must be a Buffer, Uint8Array or string. " +
      "If you passed a parsed object, your framework already consumed the raw body; see the adapters in the docs.",
  );
}

export function isRawBody(body: unknown): body is RawBody {
  return typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array;
}

export function hmacHex(algorithm: "sha256" | "sha512", key: string | Buffer, data: Buffer): string {
  return createHmac(algorithm, key).update(data).digest("hex");
}

/**
 * Constant-time string comparison. Length differences return false without
 * calling timingSafeEqual (which throws on unequal lengths); both inputs are
 * hashed-length hex in the HMAC paths, so the length itself is not secret.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still do a comparison of equal-length data so the early return is not
    // dramatically faster than a mismatch.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function getHeader(headers: HeaderBag, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Parse "t=123,v1=abc,v1=def" style headers into a multimap.
 * Whitespace around entries is ignored.
 */
export function parseKeyValueHeader(header: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    const list = out.get(key) ?? [];
    list.push(value);
    out.set(key, list);
  }
  return out;
}
