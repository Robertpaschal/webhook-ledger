import { bigint, bigserial, check, index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Drizzle definitions matching sql/001_init.sql, for apps that want to query
 * the ledger with Drizzle or let drizzle-kit own the migration.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: text("provider").notNull(),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    unique("webhook_events_provider_event_key_unique").on(t.provider, t.eventKey),
    index("webhook_events_status_idx").on(t.status, t.receivedAt),
    check("webhook_events_status_check", sql`${t.status} IN ('received', 'processed', 'failed')`),
  ],
);

export const paymentRecords = pgTable(
  "payment_records",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: text("provider").notNull(),
    reference: text("reference").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
    eventKey: text("event_key"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("payment_records_provider_reference_unique").on(t.provider, t.reference),
    index("payment_records_occurred_idx").on(t.provider, t.occurredAt),
  ],
);
