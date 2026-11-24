# Changelog

## Unreleased

- Docs: a browser [playground](https://robertpaschal.github.io/webhook-ledger/playground/) that signs and checks Paystack, Stripe and Flutterwave webhooks with Web Crypto. `tests/playground.test.ts` cross-checks it against the verifiers in both directions. Not part of the npm package.

## 0.1.0 (2026-11-23)

First release.

- Verifiers: Paystack `Paystack-Signature` (timestamped, `whsec_` signing secret, rotation) and the deprecated `X-Paystack-Signature`; Flutterwave `verif-hash`; Stripe `Stripe-Signature` with timestamp tolerance and rotation. Raw body only, constant-time comparisons.
- `Ledger.process()`: applies each event once using a unique `(provider, event_key)` row and a row lock; handler writes share the transaction; failures roll back and are recorded for retry.
- `recordPayment()` and the `payment_records` table.
- Express and Fastify adapters; framework-agnostic `handleWebhook()`.
- `webhook-ledger migrate` and `webhook-ledger reconcile` (provider API or exported JSON), with drift kinds and exit codes.
- Plain SQL migration (`sql/001_init.sql`) and Drizzle table definitions (`webhook-ledger/drizzle`).
