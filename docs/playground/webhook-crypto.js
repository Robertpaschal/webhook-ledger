// Browser-side signing and checking for the docs playground.
//
// This mirrors the verifiers in src/providers/* with the Web Crypto API so the
// playground runs entirely in the page: nothing you paste is sent anywhere.
// tests/playground.test.ts signs with this module and verifies with the
// library (and the reverse), so the two cannot drift apart silently.
//
// It is a teaching aid, not a server-side verifier. On a server, use the
// library: it compares in constant time with node:crypto.timingSafeEqual.

const enc = new TextEncoder();

function subtle(cryptoImpl) {
  const c = cryptoImpl ?? globalThis.crypto;
  if (!c?.subtle) throw new Error("Web Crypto is not available in this environment.");
  return c.subtle;
}

/** HMAC over `data` keyed with `key` (both strings, UTF-8), as lowercase hex. */
export async function hmacHex(algorithm, key, data, cryptoImpl) {
  const s = subtle(cryptoImpl);
  const hash = algorithm === "sha256" ? "SHA-256" : "SHA-512";
  const k = await s.importKey("raw", enc.encode(key), { name: "HMAC", hash }, false, ["sign"]);
  const sig = new Uint8Array(await s.sign("HMAC", k, enc.encode(data)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent-of-content comparison of two strings. */
export function equalStrings(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function parseKeyValueHeader(header) {
  const out = new Map();
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const list = out.get(key) ?? [];
    list.push(trimmed.slice(eq + 1).trim());
    out.set(key, list);
  }
  return out;
}

export const PROVIDERS = {
  paystack: { header: "Paystack-Signature", secretLabel: "Signing secret (whsec_…)" },
  "paystack-legacy": { header: "X-Paystack-Signature", secretLabel: "Secret key (sk_test_…)" },
  stripe: { header: "Stripe-Signature", secretLabel: "Endpoint secret (whsec_…)" },
  flutterwave: { header: "verif-hash", secretLabel: "Secret hash (from your dashboard)" },
};

/**
 * Produce the header a provider would send for `body`.
 * Returns { name, value }.
 */
export async function sign(provider, { body, secret, t, keyId = "key_1" }, cryptoImpl) {
  switch (provider) {
    case "paystack": {
      const hex = await hmacHex("sha512", secret, `${t}.${body}`, cryptoImpl);
      return { name: "Paystack-Signature", value: `t=${t},v1=${keyId}:${hex}` };
    }
    case "paystack-legacy":
      return { name: "X-Paystack-Signature", value: await hmacHex("sha512", secret, body, cryptoImpl) };
    case "stripe": {
      const hex = await hmacHex("sha256", secret, `${t}.${body}`, cryptoImpl);
      return { name: "Stripe-Signature", value: `t=${t},v1=${hex}` };
    }
    case "flutterwave":
      return { name: "verif-hash", value: secret };
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Check a header the way the library does. Returns
 * { ok: true } or { ok: false, reason, message } with the library's reason codes.
 */
export async function check(provider, { body, secret, header, now, toleranceSeconds = 300 }, cryptoImpl) {
  if (!secret) return { ok: false, reason: "no_secret_configured", message: "Enter the secret." };
  if (!header) return { ok: false, reason: "missing_signature", message: "Enter the signature header value." };

  let result;
  if (provider === "paystack" || provider === "stripe") {
    const parts = parseKeyValueHeader(header);
    const t = parts.get("t")?.[0];
    const v1 = parts.get("v1") ?? [];
    if (!t || !/^\d+$/.test(t) || v1.length === 0) {
      return { ok: false, reason: "malformed_signature", message: "The header must contain t=<unix seconds> and v1=…" };
    }
    if (Math.abs(now - Number(t)) > toleranceSeconds) {
      return {
        ok: false,
        reason: "timestamp_outside_tolerance",
        message: `The timestamp is ${Math.abs(now - Number(t))}s from now; the limit is ${toleranceSeconds}s.`,
      };
    }
    const algorithm = provider === "paystack" ? "sha512" : "sha256";
    const expected = await hmacHex(algorithm, secret, `${t}.${body}`, cryptoImpl);
    let matched = false;
    for (const entry of v1) {
      const colon = provider === "paystack" ? entry.lastIndexOf(":") : -1;
      const hex = (colon >= 0 ? entry.slice(colon + 1) : entry).toLowerCase();
      if (equalStrings(hex, expected)) matched = true;
    }
    result = matched
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch", message: "No v1 entry matched the HMAC of \"{t}.{body}\"." };
  } else if (provider === "paystack-legacy") {
    const expected = await hmacHex("sha512", secret, body, cryptoImpl);
    result = equalStrings(header.trim().toLowerCase(), expected)
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch", message: "The header is not the HMAC-SHA512 of the body." };
  } else if (provider === "flutterwave") {
    result = equalStrings(header.trim(), secret)
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch", message: "verif-hash does not equal the secret hash." };
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  if (!result.ok) return result;
  try {
    JSON.parse(body);
  } catch {
    return { ok: false, reason: "invalid_json", message: "The signature matches, but the body is not valid JSON." };
  }
  return result;
}
