import { describe, expect, it } from "vitest";
import { verifyPaystack } from "../src/index.js";
import { paystackChargeSuccess as body, paystackTransferSuccess } from "./fixtures/payloads.js";
import { NOW, signPaystackLegacy, signPaystackV2 } from "./helpers.js";

const WHSEC = "whsec_test_8f2a1c0e5b7d4a3f9e6c2b1a0d8f7e6c";
const WHSEC_NEXT = "whsec_test_rotated_0000000000000000000";
const SK = "sk_test_0000000000000000000000000000000000000000";

describe("Paystack-Signature (timestamped, whsec_)", () => {
  it("accepts a valid signature over the raw body", () => {
    const r = verifyPaystack(
      { rawBody: Buffer.from(body), headers: { "paystack-signature": signPaystackV2(body, WHSEC) }, now: NOW },
      { signingSecret: WHSEC },
    );
    expect(r).toMatchObject({ ok: true, eventKey: "charge.success:302961", eventType: "charge.success", scheme: "paystack-signature" });
  });

  it("matches header names case-insensitively and accepts a string body", () => {
    const r = verifyPaystack(
      { rawBody: body, headers: { "Paystack-Signature": signPaystackV2(body, WHSEC) }, now: NOW },
      { signingSecret: WHSEC },
    );
    expect(r.ok).toBe(true);
  });

  it("accepts any v1 entry during secret rotation", () => {
    const oldSig = signPaystackV2(body, WHSEC, NOW, "key_old").split(",")[1];
    const newSig = signPaystackV2(body, WHSEC_NEXT, NOW, "key_new").split(",")[1];
    const header = `t=${NOW},${oldSig},${newSig}`;
    expect(verifyPaystack({ rawBody: body, headers: { "paystack-signature": header }, now: NOW }, { signingSecret: WHSEC_NEXT }).ok).toBe(true);
    expect(verifyPaystack({ rawBody: body, headers: { "paystack-signature": header }, now: NOW }, { signingSecret: [WHSEC] }).ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signPaystackV2(body, WHSEC);
    const tampered = body.replace("1000000", "9000000");
    const r = verifyPaystack({ rawBody: tampered, headers: { "paystack-signature": sig }, now: NOW }, { signingSecret: WHSEC });
    expect(r).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a re-serialised body even when the JSON is equivalent", () => {
    const sig = signPaystackV2(body, WHSEC);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    const r = verifyPaystack({ rawBody: reserialised, headers: { "paystack-signature": sig }, now: NOW }, { signingSecret: WHSEC });
    expect(r.ok).toBe(false);
  });

  it("rejects a replay outside the tolerance window", () => {
    const sig = signPaystackV2(body, WHSEC, NOW - 301);
    const r = verifyPaystack({ rawBody: body, headers: { "paystack-signature": sig }, now: NOW }, { signingSecret: WHSEC });
    expect(r).toMatchObject({ ok: false, reason: "timestamp_outside_tolerance" });
    const inside = verifyPaystack({ rawBody: body, headers: { "paystack-signature": signPaystackV2(body, WHSEC, NOW - 299) }, now: NOW }, { signingSecret: WHSEC });
    expect(inside.ok).toBe(true);
  });

  it("rejects a signature whose timestamp was changed", () => {
    const sig = signPaystackV2(body, WHSEC).replace(`t=${NOW}`, `t=${NOW + 1}`);
    const r = verifyPaystack({ rawBody: body, headers: { "paystack-signature": sig }, now: NOW }, { signingSecret: WHSEC });
    expect(r).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects malformed headers", () => {
    for (const header of ["", "v1=key:abc", `t=${NOW}`, "t=abc,v1=key:abc"]) {
      const r = verifyPaystack({ rawBody: body, headers: { "paystack-signature": header }, now: NOW }, { signingSecret: WHSEC });
      expect(r).toMatchObject({ ok: false, reason: "malformed_signature" });
    }
  });

  it("does not fall back to the legacy header when the new one fails", () => {
    const r = verifyPaystack(
      {
        rawBody: body,
        headers: { "paystack-signature": signPaystackV2(body, "whsec_wrong"), "x-paystack-signature": signPaystackLegacy(body, SK) },
        now: NOW,
      },
      { signingSecret: WHSEC, secretKey: SK },
    );
    expect(r).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });

  it("refuses a parsed object instead of guessing its bytes", () => {
    const r = verifyPaystack(
      { rawBody: JSON.parse(body) as never, headers: { "paystack-signature": signPaystackV2(body, WHSEC) }, now: NOW },
      { signingSecret: WHSEC },
    );
    expect(r).toMatchObject({ ok: false, reason: "invalid_body" });
  });
});

describe("X-Paystack-Signature (deprecated, secret key)", () => {
  it("accepts a valid legacy signature", () => {
    const r = verifyPaystack({ rawBody: body, headers: { "x-paystack-signature": signPaystackLegacy(body, SK) } }, { secretKey: SK });
    expect(r).toMatchObject({ ok: true, scheme: "x-paystack-signature" });
  });

  it("rejects a tampered body", () => {
    const r = verifyPaystack(
      { rawBody: body.replace("NGN", "USD"), headers: { "x-paystack-signature": signPaystackLegacy(body, SK) } },
      { secretKey: SK },
    );
    expect(r).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });

  it("can be switched off", () => {
    const r = verifyPaystack(
      { rawBody: body, headers: { "x-paystack-signature": signPaystackLegacy(body, SK) } },
      { signingSecret: WHSEC, secretKey: SK, allowLegacy: false },
    );
    expect(r).toMatchObject({ ok: false, reason: "missing_signature" });
  });

  it("is not accepted when only a signing secret is configured", () => {
    const r = verifyPaystack({ rawBody: body, headers: { "x-paystack-signature": signPaystackLegacy(body, SK) } }, { signingSecret: WHSEC });
    expect(r).toMatchObject({ ok: false, reason: "missing_signature" });
  });
});

describe("Paystack configuration and keys", () => {
  it("reports missing configuration", () => {
    expect(verifyPaystack({ rawBody: body, headers: {} }, {})).toMatchObject({ ok: false, reason: "no_secret_configured" });
  });

  it("derives a key from data.id, falling back to data.reference", () => {
    const r = verifyPaystack(
      { rawBody: paystackTransferSuccess, headers: { "x-paystack-signature": signPaystackLegacy(paystackTransferSuccess, SK) } },
      { secretKey: SK },
    );
    expect(r).toMatchObject({ ok: true, eventKey: "transfer.success:trf_ref_01" });
  });

  it("accepts a custom key function", () => {
    const r = verifyPaystack(
      { rawBody: body, headers: { "x-paystack-signature": signPaystackLegacy(body, SK) } },
      { secretKey: SK, eventKey: (p) => `custom:${(p.data as { reference: string }).reference}` },
    );
    expect(r).toMatchObject({ ok: true, eventKey: "custom:qTPrJoy9Bx" });
  });
});
