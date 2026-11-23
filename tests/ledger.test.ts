import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { INIT_SQL, Ledger, recordPayment, type VerifiedEvent } from "../src/index.js";
import { describeDb, freshSchema } from "./helpers.js";

it("sql/001_init.sql and INIT_SQL are identical", () => {
  expect(readFileSync(new URL("../sql/001_init.sql", import.meta.url), "utf8")).toBe(INIT_SQL);
});

function event(key: string, amount = 1000): VerifiedEvent<{ amount: number }> {
  return { ok: true, provider: "paystack", eventKey: key, eventType: "charge.success", payload: { amount }, scheme: "test" };
}

describeDb("Ledger (Postgres)", () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  let ledger: Ledger;

  beforeAll(async () => {
    ({ pool, drop } = await freshSchema());
    ledger = new Ledger(pool);
    await ledger.migrate();
    await ledger.migrate(); // idempotent
    await pool.query("CREATE TABLE wallet (id int PRIMARY KEY, balance bigint NOT NULL)");
    await pool.query("INSERT INTO wallet VALUES (1, 0)");
  });
  afterAll(async () => drop());

  const credit = async ({ event, client }: { event: VerifiedEvent<{ amount: number }>; client: { query: pg.Pool["query"] } }) => {
    await client.query("UPDATE wallet SET balance = balance + $1 WHERE id = 1", [event.payload.amount]);
  };
  const balance = async () => Number((await pool.query("SELECT balance FROM wallet WHERE id = 1")).rows[0].balance);

  it("applies an event once and reports the redelivery as a duplicate", async () => {
    const before = await balance();
    expect(await ledger.process(event("dup-1"), credit as never)).toMatchObject({ status: "processed" });
    expect(await ledger.process(event("dup-1"), credit as never)).toMatchObject({ status: "duplicate" });
    expect(await balance()).toBe(before + 1000);
    const row = (await pool.query("SELECT status, attempts FROM webhook_events WHERE event_key = 'dup-1'")).rows[0];
    expect(row).toEqual({ status: "processed", attempts: 1 });
  });

  it("applies an event once under 10 concurrent deliveries", async () => {
    const before = await balance();
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ledger.process(event("race-1", 7), async (ctx) => {
          calls++;
          await new Promise((r) => setTimeout(r, 20));
          await credit(ctx as never);
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(results.filter((r) => r.status === "processed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(9);
    expect(await balance()).toBe(before + 7);
  });

  it("applies a previously failed event once under concurrent retries", async () => {
    // The row already exists, so the INSERT does not serialise the retries;
    // only the row lock does.
    await ledger.process(event("race-2", 3), () => {
      throw new Error("first attempt fails");
    });
    const before = await balance();
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ledger.process(event("race-2", 3), async (ctx) => {
          calls++;
          await new Promise((r) => setTimeout(r, 20));
          await credit(ctx as never);
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(9);
    expect(await balance()).toBe(before + 3);
  });

  it("rolls back the handler's writes on failure and retries on the next delivery", async () => {
    const before = await balance();
    const boom = await ledger.process(event("fail-1", 50), async (ctx) => {
      await credit(ctx as never);
      throw new Error("downstream timeout");
    });
    expect(boom).toMatchObject({ status: "failed" });
    expect(await balance()).toBe(before);
    let row = (await pool.query("SELECT status, attempts, last_error FROM webhook_events WHERE event_key = 'fail-1'")).rows[0];
    expect(row).toEqual({ status: "failed", attempts: 1, last_error: "downstream timeout" });

    expect(await ledger.process(event("fail-1", 50), credit as never)).toMatchObject({ status: "processed" });
    expect(await balance()).toBe(before + 50);
    row = (await pool.query("SELECT status, attempts, last_error FROM webhook_events WHERE event_key = 'fail-1'")).rows[0];
    expect(row).toEqual({ status: "processed", attempts: 2, last_error: null });
  });

  it("keys events per provider", async () => {
    const a = await ledger.process(event("shared-key"), () => {});
    const b = await ledger.process({ ...event("shared-key"), provider: "stripe" }, () => {});
    expect([a.status, b.status]).toEqual(["processed", "processed"]);
  });

  it("records payments inside the handler transaction", async () => {
    await ledger.process(event("pay-1"), async ({ client }) => {
      await recordPayment(client, { provider: "paystack", reference: "ref-1", amountMinor: 1000000n, currency: "ngn", status: "success", eventKey: "pay-1" });
    });
    const row = (await pool.query("SELECT amount_minor, currency, status FROM payment_records WHERE reference = 'ref-1'")).rows[0];
    expect(row).toEqual({ amount_minor: "1000000", currency: "NGN", status: "success" });
  });
});

describeDb("Drizzle schema matches the SQL migration", () => {
  it("reads and writes both tables through drizzle-orm", async () => {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { webhookEvents, paymentRecords } = await import("../src/drizzle.js");
    const { pool, drop } = await freshSchema();
    try {
      await new Ledger(pool).migrate();
      const db = drizzle(pool);
      await db.insert(paymentRecords).values({ provider: "stripe", reference: "pi_1", amountMinor: 2000n, currency: "USD", status: "succeeded" });
      await db.insert(webhookEvents).values({ provider: "stripe", eventKey: "evt_1", eventType: "x", payload: { a: 1 } });
      const [p] = await db.select().from(paymentRecords);
      const [e] = await db.select().from(webhookEvents);
      expect(p.amountMinor).toBe(2000n);
      expect(e).toMatchObject({ status: "received", attempts: 0, payload: { a: 1 } });
    } finally {
      await drop();
    }
  });
});
