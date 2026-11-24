// The docs playground re-implements signing and checking with Web Crypto so it
// can run in a browser. These tests tie it to the library in both directions,
// so a change to either side that breaks agreement fails CI.
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyFlutterwave, verifyPaystack, verifyStripe } from "../src/index.js";
// @ts-expect-error: plain browser ES module without type declarations
import { check, sign } from "../docs/playground/webhook-crypto.js";
import { NOW, signPaystackLegacy, signPaystackV2, signStripe } from "./helpers.js";

const wc = webcrypto as unknown as Crypto;
const bodies = [
  JSON.stringify({ event: "charge.success", data: { id: 302961, reference: "ord_1042", amount: 250000, currency: "NGN" } }),
  JSON.stringify({ event: "transfer.success", data: { transfer_code: "TRF_x", note: "naïve café ₦ 🚀" } }),
];
const stripeBodies = [
  JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { amount: 2500 } } }),
  JSON.stringify({ id: "evt_2", type: "charge.refunded", data: { object: { note: "ünïcødé ✓" } } }),
];

describe("playground signs what the library accepts", () => {
  for (const body of bodies) {
    it(`Paystack-Signature: ${body.slice(0, 40)}`, async () => {
      const h = await sign("paystack", { body, secret: "whsec_abc", t: NOW }, wc);
      const r = verifyPaystack({ rawBody: body, headers: { [h.name]: h.value }, now: NOW }, { signingSecret: "whsec_abc" });
      expect(r.ok).toBe(true);
    });
    it(`X-Paystack-Signature: ${body.slice(0, 40)}`, async () => {
      const h = await sign("paystack-legacy", { body, secret: "sk_test_abc" }, wc);
      const r = verifyPaystack({ rawBody: body, headers: { [h.name]: h.value }, now: NOW }, { secretKey: "sk_test_abc" });
      expect(r.ok).toBe(true);
    });
  }
  for (const body of stripeBodies) {
    it(`Stripe-Signature: ${body.slice(0, 40)}`, async () => {
      const h = await sign("stripe", { body, secret: "whsec_s", t: NOW }, wc);
      const r = verifyStripe({ rawBody: body, headers: { [h.name]: h.value }, now: NOW }, { signingSecret: "whsec_s" });
      expect(r.ok).toBe(true);
    });
  }
  it("verif-hash", async () => {
    const body = JSON.stringify({ event: "charge.completed", data: { id: 1, tx_ref: "ord" } });
    const h = await sign("flutterwave", { body, secret: "hash-1" }, wc);
    const r = verifyFlutterwave({ rawBody: body, headers: { [h.name]: h.value } }, { secretHash: "hash-1" });
    expect(r.ok).toBe(true);
  });
});

describe("playground checks agree with the library", () => {
  const body = bodies[1];
  const sbody = stripeBodies[1];
  const cases: Array<{ name: string; provider: string; secret: string; header: string; body: string; lib: () => { ok: boolean; reason?: string } }> = [
    {
      name: "valid Paystack-Signature",
      provider: "paystack", secret: "whsec_abc", body, header: signPaystackV2(body, "whsec_abc"),
      lib: () => verifyPaystack({ rawBody: body, headers: { "paystack-signature": signPaystackV2(body, "whsec_abc") }, now: NOW }, { signingSecret: "whsec_abc" }),
    },
    {
      name: "re-serialised body, Paystack",
      provider: "paystack", secret: "whsec_abc", body: JSON.stringify(JSON.parse(body), null, 1), header: signPaystackV2(body, "whsec_abc"),
      lib: () => verifyPaystack({ rawBody: JSON.stringify(JSON.parse(body), null, 1), headers: { "paystack-signature": signPaystackV2(body, "whsec_abc") }, now: NOW }, { signingSecret: "whsec_abc" }),
    },
    {
      name: "stale Paystack timestamp",
      provider: "paystack", secret: "whsec_abc", body, header: signPaystackV2(body, "whsec_abc", NOW - 301),
      lib: () => verifyPaystack({ rawBody: body, headers: { "paystack-signature": signPaystackV2(body, "whsec_abc", NOW - 301) }, now: NOW }, { signingSecret: "whsec_abc" }),
    },
    {
      name: "malformed Paystack header",
      provider: "paystack", secret: "whsec_abc", body, header: "v1=key_1:abc",
      lib: () => verifyPaystack({ rawBody: body, headers: { "paystack-signature": "v1=key_1:abc" }, now: NOW }, { signingSecret: "whsec_abc" }),
    },
    {
      name: "valid legacy, uppercase hex",
      provider: "paystack-legacy", secret: "sk_test_abc", body, header: signPaystackLegacy(body, "sk_test_abc").toUpperCase(),
      lib: () => verifyPaystack({ rawBody: body, headers: { "x-paystack-signature": signPaystackLegacy(body, "sk_test_abc").toUpperCase() }, now: NOW }, { secretKey: "sk_test_abc" }),
    },
    {
      name: "legacy with the wrong key",
      provider: "paystack-legacy", secret: "sk_test_other", body, header: signPaystackLegacy(body, "sk_test_abc"),
      lib: () => verifyPaystack({ rawBody: body, headers: { "x-paystack-signature": signPaystackLegacy(body, "sk_test_abc") }, now: NOW }, { secretKey: "sk_test_other" }),
    },
    {
      name: "valid Stripe",
      provider: "stripe", secret: "whsec_s", body: sbody, header: signStripe(sbody, "whsec_s"),
      lib: () => verifyStripe({ rawBody: sbody, headers: { "stripe-signature": signStripe(sbody, "whsec_s") }, now: NOW }, { signingSecret: "whsec_s" }),
    },
    {
      name: "Stripe with one byte changed",
      provider: "stripe", secret: "whsec_s", body: sbody + " ", header: signStripe(sbody, "whsec_s"),
      lib: () => verifyStripe({ rawBody: sbody + " ", headers: { "stripe-signature": signStripe(sbody, "whsec_s") }, now: NOW }, { signingSecret: "whsec_s" }),
    },
    {
      name: "wrong verif-hash",
      provider: "flutterwave", secret: "hash-1", body, header: "hash-2",
      lib: () => verifyFlutterwave({ rawBody: body, headers: { "verif-hash": "hash-2" } }, { secretHash: "hash-1" }),
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const mine = await check(c.provider, { body: c.body, secret: c.secret, header: c.header, now: NOW }, wc);
      const lib = c.lib();
      expect(mine.ok).toBe(lib.ok);
      if (!lib.ok) expect(mine.reason).toBe(lib.reason);
    });
  }

  it("signature valid but body not JSON is invalid_json in both", async () => {
    const raw = "not json";
    const header = signStripe(raw, "whsec_s");
    const mine = await check("stripe", { body: raw, secret: "whsec_s", header, now: NOW }, wc);
    const lib = verifyStripe({ rawBody: raw, headers: { "stripe-signature": header }, now: NOW }, { signingSecret: "whsec_s" });
    expect(lib.ok).toBe(false);
    expect(mine).toMatchObject({ ok: false, reason: lib.ok ? "" : lib.reason });
  });
});
