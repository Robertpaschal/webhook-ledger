// A runnable example: Paystack + Stripe webhooks into one ledger.
//
//   createdb webhook_ledger_example
//   DATABASE_URL=postgres://localhost/webhook_ledger_example \
//   PAYSTACK_WEBHOOK_SECRET=whsec_... STRIPE_WEBHOOK_SECRET=whsec_... \
//   node examples/express/server.mjs
//
// Then send a signed test event: node examples/express/send-test-event.mjs
import express from "express";
import pg from "pg";
import { Ledger, expressWebhook, recordPayment } from "webhook-ledger";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ledger = new Ledger(pool);
await ledger.migrate();

const app = express();
const log = (outcome) =>
  console.log(outcome.kind === "rejected" ? `rejected: ${outcome.verify.reason}` : `${outcome.result.status}: ${outcome.result.eventKey}`);

app.post(
  "/webhooks/paystack",
  express.raw({ type: "*/*" }),
  expressWebhook({
    provider: "paystack",
    options: { signingSecret: process.env.PAYSTACK_WEBHOOK_SECRET, secretKey: process.env.PAYSTACK_SECRET_KEY },
    ledger,
    onOutcome: log,
    handler: async ({ event, client }) => {
      if (event.eventType !== "charge.success") return;
      const { reference, amount, currency, status } = event.payload.data;
      await recordPayment(client, { provider: "paystack", reference, amountMinor: amount, currency, status, eventKey: event.eventKey });
    },
  }),
);

app.post(
  "/webhooks/stripe",
  express.raw({ type: "*/*" }),
  expressWebhook({
    provider: "stripe",
    options: { signingSecret: process.env.STRIPE_WEBHOOK_SECRET },
    ledger,
    onOutcome: log,
    handler: async ({ event, client }) => {
      if (event.eventType !== "payment_intent.succeeded") return;
      const pi = event.payload.data.object;
      await recordPayment(client, { provider: "stripe", reference: pi.id, amountMinor: pi.amount, currency: pi.currency, status: pi.status, eventKey: event.eventKey });
    },
  }),
);

app.listen(3000, () => console.log("listening on http://localhost:3000"));
