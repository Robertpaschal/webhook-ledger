// Kept in sync with sql/001_init.sql by tests/schema.test.ts.
export const INIT_SQL = `-- webhook-ledger schema, version 1.
-- Plain SQL so it works with any migration tool. Safe to run more than once.

CREATE TABLE IF NOT EXISTS webhook_events (
  id            bigserial PRIMARY KEY,
  provider      text        NOT NULL,
  event_key     text        NOT NULL,
  event_type    text        NOT NULL,
  payload       jsonb       NOT NULL,
  status        text        NOT NULL DEFAULT 'received'
                CHECK (status IN ('received', 'processed', 'failed')),
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  CONSTRAINT webhook_events_provider_event_key_unique UNIQUE (provider, event_key)
);

CREATE INDEX IF NOT EXISTS webhook_events_status_idx ON webhook_events (status, received_at);

-- One row per payment the application has given value for. Written by the
-- application (usually inside the webhook handler, in the same transaction)
-- and compared against the provider by \`webhook-ledger reconcile\`.
CREATE TABLE IF NOT EXISTS payment_records (
  id            bigserial PRIMARY KEY,
  provider      text        NOT NULL,
  reference     text        NOT NULL,
  amount_minor  bigint      NOT NULL,
  currency      text        NOT NULL,
  status        text        NOT NULL,
  event_key     text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_records_provider_reference_unique UNIQUE (provider, reference)
);

CREATE INDEX IF NOT EXISTS payment_records_occurred_idx ON payment_records (provider, occurred_at);
`;
