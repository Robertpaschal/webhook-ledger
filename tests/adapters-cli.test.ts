import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { expressWebhook, fastifyWebhook, Ledger, recordPayment } from "../src/index.js";
import { runCli } from "../src/cli.js";
import { paystackChargeSuccess, stripePaymentIntentSucceeded } from "./fixtures/payloads.js";
import { describeDb, freshSchema, POSTGRES_URL, signPaystackV2, signStripe } from "./helpers.js";

const WHSEC = "whsec_test_adapter_secret";
const STRIPE_WHSEC = "whsec_test_stripe_adapter";

describeDb("adapters and CLI (Postgres)", () => {
  let pool: pg.Pool;
  let schema: string;
  let drop: () => Promise<void>;
  let ledger: Ledger;
  let applied = 0;

  beforeAll(async () => {
    ({ pool, schema, drop } = await freshSchema());
    ledger = new Ledger(pool);
    await ledger.migrate();
  });
  afterAll(async () => drop());

  it("Express: 200 processed, 200 duplicate, 401 tampered, 500 when the raw body is gone", async () => {
    const app = express();
    const handler = expressWebhook({
      provider: "paystack",
      options: { signingSecret: WHSEC },
      ledger,
      handler: async ({ client, event }) => {
        applied++;
        const data = (event.payload as { data: { reference: string; amount: number; currency: string; status: string } }).data;
        await recordPayment(client, { provider: "paystack", reference: data.reference, amountMinor: data.amount, currency: data.currency, status: data.status, eventKey: event.eventKey });
      },
    });
    app.post("/paystack", express.raw({ type: "*/*" }), handler);
    app.post("/parsed", express.json(), handler);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const send = (path: string, body: string, sig: string) =>
        fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "paystack-signature": sig }, body });
      const sig = signPaystackV2(paystackChargeSuccess, WHSEC, Math.floor(Date.now() / 1000));

      let res = await send("/paystack", paystackChargeSuccess, sig);
      expect([res.status, await res.json()]).toEqual([200, { ok: true, status: "processed" }]);
      res = await send("/paystack", paystackChargeSuccess, sig);
      expect([res.status, await res.json()]).toEqual([200, { ok: true, status: "duplicate" }]);
      res = await send("/paystack", paystackChargeSuccess.replace("1000000", "1"), sig);
      expect([res.status, await res.json()]).toEqual([401, { ok: false, status: "rejected", reason: "signature_mismatch" }]);
      res = await send("/parsed", paystackChargeSuccess, sig);
      expect(res.status).toBe(500);
      expect(applied).toBe(1);
    } finally {
      server.close();
    }
  });

  it("Fastify: verifies the raw body even with JSON content-type", async () => {
    const app = Fastify();
    let calls = 0;
    await app.register(fastifyWebhook, {
      path: "/stripe",
      provider: "stripe",
      options: { signingSecret: STRIPE_WHSEC },
      ledger,
      handler: () => {
        calls++;
      },
    });
    const sig = signStripe(stripePaymentIntentSucceeded, STRIPE_WHSEC, Math.floor(Date.now() / 1000));
    const inject = (body: string) =>
      app.inject({ method: "POST", url: "/stripe", headers: { "content-type": "application/json", "stripe-signature": sig }, payload: body });
    expect((await inject(stripePaymentIntentSucceeded)).json()).toEqual({ ok: true, status: "processed" });
    expect((await inject(stripePaymentIntentSucceeded)).json()).toEqual({ ok: true, status: "duplicate" });
    expect((await inject(stripePaymentIntentSucceeded.replace("2000", "1"))).statusCode).toBe(401);
    expect(calls).toBe(1);
    await app.close();
  });

  it("CLI: migrate, then reconcile an export against the ledger with exit code 1 on drift", async () => {
    const url = new URL(POSTGRES_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env: { DATABASE_URL: url.toString() } };

    expect(await runCli(["migrate"], io)).toBe(0);

    // The Express test recorded qTPrJoy9Bx for 1,000,000 kobo. Plant drift on the provider side.
    await pool.query("UPDATE payment_records SET occurred_at = '2026-11-20T09:14:00Z'");
    const dir = mkdtempSync(join(tmpdir(), "wl-"));
    const file = join(dir, "paystack.json");
    writeFileSync(
      file,
      JSON.stringify([
        { reference: "qTPrJoy9Bx", amountMinor: "999000", currency: "NGN", status: "success" },
        { reference: "never-recorded", amountMinor: "5000", currency: "NGN", status: "success" },
      ]),
    );
    const code = await runCli(["reconcile", "--provider", "paystack", "--from", "2026-11-01", "--to", "2026-12-01", "--input", file, "--json"], io);
    expect(err).toEqual([]);
    expect(code).toBe(1);
    const report = JSON.parse(out.at(-1)!);
    expect(report.drift.map((d: { kind: string }) => d.kind).sort()).toEqual(["amount_mismatch", "missing_in_ledger"]);

    writeFileSync(file, JSON.stringify([{ reference: "qTPrJoy9Bx", amountMinor: "1000000", currency: "NGN", status: "success" }]));
    expect(await runCli(["reconcile", "--provider", "paystack", "--from", "2026-11-01", "--to", "2026-12-01", "--input", file], io)).toBe(0);
  });

  it("CLI: usage errors exit 2 and never print secrets", async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (l: string) => err.push(l), env: { DATABASE_URL: "postgres://x", PAYSTACK_SECRET_KEY: undefined } };
    expect(await runCli(["reconcile", "--provider", "paypal", "--from", "2026-11-01", "--to", "2026-11-02"], io)).toBe(2);
    expect(await runCli(["reconcile", "--provider", "paystack", "--from", "2026-11-01", "--to", "2026-11-02"], io)).toBe(2);
    expect(err.join("\n")).toContain("Set PAYSTACK_SECRET_KEY");
    expect(await runCli([], io)).toBe(2);
  });
});
