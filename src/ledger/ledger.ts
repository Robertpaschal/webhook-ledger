import type { Provider, VerifiedEvent } from "../types.js";
import { INIT_SQL } from "./sql.js";

/** The subset of `pg.PoolClient` the ledger uses. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/** The subset of `pg.Pool` the ledger uses. */
export interface SqlPool extends SqlClient {
  connect(): Promise<SqlClient & { release(err?: Error | boolean): void }>;
}

export interface HandlerContext<T = unknown> {
  event: VerifiedEvent<T>;
  /**
   * The client holding the ledger transaction. Write your side effects with it
   * (credit a wallet, mark an order paid, `recordPayment`) and they commit or
   * roll back together with the event's processed mark.
   */
  client: SqlClient;
}

export type EventHandler<T = unknown> = (ctx: HandlerContext<T>) => Promise<void> | void;

export type ProcessOutcome =
  | { status: "processed"; eventKey: string }
  | { status: "duplicate"; eventKey: string }
  | { status: "failed"; eventKey: string; error: Error };

export interface PaymentRecordInput {
  provider: Provider;
  reference: string;
  /** Integer amount in the currency's minor unit (kobo, cents). */
  amountMinor: number | bigint;
  currency: string;
  status: string;
  eventKey?: string;
  occurredAt?: Date;
}

export async function migrate(db: SqlClient): Promise<void> {
  await db.query(INIT_SQL);
}

/** Upsert one payment row. Call it from a handler with `ctx.client`. */
export async function recordPayment(client: SqlClient, input: PaymentRecordInput): Promise<void> {
  await client.query(
    `INSERT INTO payment_records (provider, reference, amount_minor, currency, status, event_key, occurred_at)
     VALUES ($1, $2, $3, upper($4), $5, $6, coalesce($7, now()))
     ON CONFLICT (provider, reference) DO UPDATE
       SET amount_minor = EXCLUDED.amount_minor,
           currency     = EXCLUDED.currency,
           status       = EXCLUDED.status,
           event_key    = coalesce(EXCLUDED.event_key, payment_records.event_key),
           updated_at   = now()`,
    [
      input.provider,
      input.reference,
      String(input.amountMinor),
      input.currency,
      input.status,
      input.eventKey ?? null,
      input.occurredAt ?? null,
    ],
  );
}

function truncate(message: string, max = 2000): string {
  return message.length > max ? `${message.slice(0, max)}…` : message;
}

export class Ledger {
  constructor(private readonly pool: SqlPool) {}

  migrate(): Promise<void> {
    return migrate(this.pool);
  }

  /**
   * Apply `handler` to `event` at most once.
   *
   * Concurrent deliveries of the same event serialise on a row lock; the
   * second one sees `processed` and returns `duplicate` without calling the
   * handler. If the handler throws, everything it wrote is rolled back, the
   * event is marked `failed` with the error, and the next delivery retries it.
   */
  async process<T>(event: VerifiedEvent<T>, handler: EventHandler<T>): Promise<ProcessOutcome> {
    const client = await this.pool.connect();
    let released = false;
    const release = (err?: Error) => {
      if (!released) {
        released = true;
        client.release(err);
      }
    };
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO webhook_events (provider, event_key, event_type, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (provider, event_key) DO NOTHING`,
        [event.provider, event.eventKey, event.eventType, JSON.stringify(event.payload)],
      );
      const { rows } = await client.query(
        `SELECT status FROM webhook_events WHERE provider = $1 AND event_key = $2 FOR UPDATE`,
        [event.provider, event.eventKey],
      );
      if (rows[0]?.status === "processed") {
        await client.query("COMMIT");
        return { status: "duplicate", eventKey: event.eventKey };
      }
      try {
        await handler({ event, client });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        await client.query("ROLLBACK");
        await this.markFailed(client, event, error);
        return { status: "failed", eventKey: event.eventKey, error };
      }
      await client.query(
        `UPDATE webhook_events
            SET status = 'processed', processed_at = now(), attempts = attempts + 1, last_error = NULL
          WHERE provider = $1 AND event_key = $2`,
        [event.provider, event.eventKey],
      );
      await client.query("COMMIT");
      return { status: "processed", eventKey: event.eventKey };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // connection may already be broken
      }
      release(err as Error);
      throw err;
    } finally {
      release();
    }
  }

  private async markFailed(client: SqlClient, event: VerifiedEvent<unknown>, error: Error): Promise<void> {
    await client.query(
      `INSERT INTO webhook_events (provider, event_key, event_type, payload, status, attempts, last_error)
       VALUES ($1, $2, $3, $4::jsonb, 'failed', 1, $5)
       ON CONFLICT (provider, event_key) DO UPDATE
         SET status = CASE WHEN webhook_events.status = 'processed' THEN 'processed' ELSE 'failed' END,
             attempts = webhook_events.attempts + 1,
             last_error = EXCLUDED.last_error`,
      [event.provider, event.eventKey, event.eventType, JSON.stringify(event.payload), truncate(error.message)],
    );
  }
}
