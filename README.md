# webhook-ledger

[![CI](https://github.com/Robertpaschal/webhook-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/Robertpaschal/webhook-ledger/actions/workflows/ci.yml)

Verified, idempotent payment webhooks for Node.js: signature checks for **Paystack**, **Flutterwave** and **Stripe**, a small **Postgres ledger** that applies each event once even when the provider retries, and a **reconciliation CLI** that compares what you recorded with what the provider says happened.

Docs: https://robertpaschal.github.io/webhook-ledger/

```bash
npm install webhook-ledger pg
```

## Why

Payment webhooks fail in three boring ways:

1. **Unverified bodies.** Verifying a re-serialised `req.body` instead of the raw bytes passes in tests and breaks (or silently accepts the wrong thing) in production.
2. **Double application.** Providers retry until they get a 2xx. A slow handler, a deploy or a timeout means the same `charge.success` arrives twice and a wallet is credited twice.
3. **Silent drift.** A webhook that never arrived, or a handler that failed after the provider gave up retrying, leaves your database disagreeing with the provider, and nothing tells you.

webhook-ledger handles each one: verify against the raw body with constant-time comparison, record the event under a unique key and run your handler inside the same transaction, and reconcile the result against the provider's transaction list.

## Quick start (Express)

```ts
import express from "express";
import pg from "pg";
import { Ledger, expressWebhook, recordPayment } from "webhook-ledger";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ledger = new Ledger(pool);
await ledger.migrate(); // or run sql/001_init.sql with your own migration tool

const app = express();

app.post(
  "/webhooks/paystack",
  express.raw({ type: "*/*" }), // the raw bytes are what Paystack signed
  expressWebhook({
    provider: "paystack",
    options: {
      signingSecret: process.env.PAYSTACK_WEBHOOK_SECRET, // whsec_… (Paystack-Signature)
      secretKey: process.env.PAYSTACK_SECRET_KEY,         // sk_… (deprecated X-Paystack-Signature)
    },
    ledger,
    handler: async ({ event, client }) => {
      if (event.eventType !== "charge.success") return;
      const { reference, amount, currency, status } = (event.payload as any).data;
      // Use `client`: these writes commit or roll back with the event's processed mark.
      await client.query("UPDATE orders SET paid = true WHERE reference = $1", [reference]);
      await recordPayment(client, { provider: "paystack", reference, amountMinor: amount, currency, status, eventKey: event.eventKey });
    },
  }),
);
```

Responses are chosen so providers retry exactly when they should:

| Situation | Status | Ledger |
| --- | --- | --- |
| Valid, first delivery, handler succeeded | `200 {status:"processed"}` | row marked `processed` |
| Valid, already processed | `200 {status:"duplicate"}` | unchanged, handler not called |
| Valid, handler threw | `500 {status:"failed"}` | handler writes rolled back, row marked `failed` with the error, next delivery retries |
| Bad, missing or stale signature | `401` | nothing written |
| Body is not JSON | `400` | nothing written |
| No secret configured, or raw body unavailable | `500` | nothing written |

## Fastify

```ts
import Fastify from "fastify";
import { fastifyWebhook } from "webhook-ledger";

const app = Fastify();
await app.register(fastifyWebhook, {
  path: "/webhooks/stripe",
  provider: "stripe",
  options: { signingSecret: process.env.STRIPE_WEBHOOK_SECRET },
  ledger,
  handler: async ({ event, client }) => { /* … */ },
});
```

The plugin replaces the body parsers inside its own encapsulated context so the route receives the raw `Buffer`; the rest of your app keeps its JSON parser.

## Verification only

You can use the verifiers without the ledger:

```ts
import { verifyPaystack, verifyFlutterwave, verifyStripe } from "webhook-ledger";

const result = verifyStripe(
  { rawBody: req.body /* Buffer */, headers: req.headers },
  { signingSecret: process.env.STRIPE_WEBHOOK_SECRET },
);
if (!result.ok) return res.status(401).end(); // result.reason: "signature_mismatch" | "timestamp_outside_tolerance" | …
result.eventKey;  // "evt_…"
result.payload;   // parsed JSON
```

Every verifier refuses a parsed object (`invalid_body`) rather than guessing its bytes.

### What each provider check does

| Provider | Header | Check |
| --- | --- | --- |
| Paystack (current) | `Paystack-Signature: t=<unix seconds>,v1=<key id>:<hex>` | HMAC-SHA512 over `"{t}.{raw body}"`, keyed with the whole `whsec_…` signing secret; any `v1` entry may match (rotation sends one per live secret); timestamp must be within `toleranceSeconds` (default 300). |
| Paystack (deprecated) | `X-Paystack-Signature: <hex>` | HMAC-SHA512 of the raw body keyed with your secret key. Accepted when `secretKey` is set, unless `allowLegacy: false`. Never used as a fallback when a `Paystack-Signature` header is present and fails. |
| Flutterwave | `verif-hash: <secret hash>` | Constant-time equality with the secret hash from your dashboard. |
| Stripe | `Stripe-Signature: t=…,v1=…` | HMAC-SHA256 over `"{t}.{raw body}"` keyed with the `whsec_…` endpoint secret; any `v1` may match; `v0` is ignored; tolerance 300s. Tested against headers generated by Stripe's own Node SDK. |

### Idempotency keys

| Provider | Default `eventKey` |
| --- | --- |
| Stripe | `event.id` |
| Paystack | `"{event}:{data.id}"`, falling back to `data.reference`, `data.transfer_code`, `data.subscription_code`, `data.code` (Paystack payloads carry no event id) |
| Flutterwave | `"{event}:{data.id}"`, falling back to `data.tx_ref`, `data.flw_ref` |

Pass `eventKey: (payload) => string` in the options to choose your own. Keys are unique per provider.

## How "once" is enforced

`Ledger.process(event, handler)` runs in one transaction:

1. `INSERT … ON CONFLICT (provider, event_key) DO NOTHING`
2. `SELECT status … FOR UPDATE`. Concurrent deliveries of the same event wait here.
3. If the row is already `processed`, commit and return `duplicate` without calling the handler.
4. Otherwise run the handler with the transaction's client, mark the row `processed` and commit.
5. If the handler throws, roll back everything (including the handler's writes) and record `failed`, the attempt count and the error.

The test suite runs this against real Postgres 16, including ten concurrent deliveries of a new event and ten concurrent retries of a previously failed one. The handler runs once in both. Removing the row lock makes the second test fail.

The guarantee covers what the handler writes **through `client`**. Calls to other systems (sending an email, calling another API) are not rolled back; make those idempotent on `event.eventKey` yourself.

## Schema

`sql/001_init.sql` creates two tables and is safe to run repeatedly:

- `webhook_events`: one row per `(provider, event_key)` with the payload, `status` (`received` / `processed` / `failed`), attempts, last error and timestamps.
- `payment_records`: one row per `(provider, reference)` you gave value for, with `amount_minor` (bigint, kobo/cents), currency and status. `recordPayment()` upserts it. This is what reconciliation reads.

Drizzle users can import matching table definitions:

```ts
import { webhookEvents, paymentRecords } from "webhook-ledger/drizzle";
```

## Reconciliation CLI

```bash
export DATABASE_URL=postgres://…
npx webhook-ledger migrate

# Against the provider API (key from the environment only)
PAYSTACK_SECRET_KEY=sk_test_… npx webhook-ledger reconcile --provider paystack --from 2026-11-01 --to 2026-12-01

# Or against an exported list, no API key needed
npx webhook-ledger reconcile --provider stripe --from 2026-11-01 --to 2026-12-01 --input stripe-export.json --json
```

It reports:

- `missing_in_ledger`: the provider has a **successful** transaction you never recorded (abandoned checkouts are not drift)
- `missing_at_provider`: you recorded a payment the provider does not have in that window
- `amount_mismatch`, `currency_mismatch`, `status_mismatch`

Statuses are normalised across vocabularies (`success`, `successful`, `succeeded` are the same thing). Exit code is `0` with no drift, `1` with drift and `2` on errors, so it can run on a schedule and alert.

Sources used: Paystack `GET /transaction` (amounts already in kobo), Flutterwave `GET /v3/transactions` (amounts in major units, converted with two decimals; pass `decimals: 0` from the API for zero-decimal currencies), Stripe `GET /v1/payment_intents` (cursor-paginated, reference is the PaymentIntent id).

The `--input` file is a JSON array of `{ reference, amountMinor, currency, status, occurredAt? }`.

## Limits (read before you rely on it)

- **Tested against fixtures, not live accounts.** The verifiers are tested with signatures computed from the documented schemes (and, for Stripe, cross-checked with Stripe's SDK). The API sources for reconciliation are tested against recorded response shapes. I have not run them against live provider accounts. Please open an issue if a real payload or response doesn't match.
- **Paystack's `Paystack-Signature` scheme is new** (added to Paystack's docs in November 2026). This implementation follows the documented format; if Paystack changes details, the verifier needs to follow.
- **Flutterwave's `verif-hash` is a shared secret, not a signature over the body.** It shows the sender knows your hash; it does not prove the body wasn't altered. Re-fetch the transaction from Flutterwave before giving value on high-value events, and run reconciliation. Flutterwave's newer signed-webhook header, if your account sends one, is not implemented yet.
- **Reconciliation compares references in a time window.** Payments recorded near the window edges can show as `missing_*` if your `occurred_at` and the provider's timestamp fall on different sides. Overlap windows or rerun.
- **Refunds and partial captures** are compared by status only; there is no refund ledger yet.
- Only Postgres. Only Express and Fastify adapters (anything else can call `handleWebhook(config, rawBody, headers)`).
- Not affiliated with Paystack, Flutterwave or Stripe.

## Development

```bash
npm install
POSTGRES_URL=postgres://user@localhost:5432/webhook_ledger npm test
npm run typecheck && npm run lint && npm run build
```

Database suites skip locally without `POSTGRES_URL`. In CI (`CI` set) a missing `POSTGRES_URL` is an error, so the suite can't go green by running nothing. CI runs on Node 18 (with Fastify 4) and Node 22 (with Fastify 5) against Postgres 16, then installs the packed tarball and runs the CLI.

## Licence

MIT © Odinaka Robert Nnamani
