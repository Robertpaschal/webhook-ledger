export type {
  Provider,
  HeaderBag,
  RawBody,
  VerifiedEvent,
  VerifyFailure,
  VerifyFailureReason,
  VerifyResult,
  VerifyInput,
} from "./types.js";

export { verifyPaystack, defaultPaystackEventKey, type PaystackVerifyOptions } from "./providers/paystack.js";
export { verifyFlutterwave, defaultFlutterwaveEventKey, type FlutterwaveVerifyOptions } from "./providers/flutterwave.js";
export { verifyStripe, defaultStripeEventKey, type StripeVerifyOptions } from "./providers/stripe.js";

export {
  Ledger,
  migrate,
  recordPayment,
  type SqlClient,
  type SqlPool,
  type EventHandler,
  type HandlerContext,
  type ProcessOutcome,
  type PaymentRecordInput,
} from "./ledger/ledger.js";
export { INIT_SQL } from "./ledger/sql.js";

export {
  verifyWebhook,
  handleWebhook,
  type ProviderConfig,
  type WebhookConfig,
  type HandleOutcome,
  type HttpResponse,
} from "./handle.js";
export { expressWebhook } from "./adapters/express.js";
export { fastifyWebhook, type FastifyWebhookOptions } from "./adapters/fastify.js";

export {
  reconcile,
  normalizeStatus,
  loadLedgerTransactions,
  formatReport,
  reportToJson,
  type Transaction,
  type Drift,
  type DriftKind,
  type ReconcileReport,
  type NormalizedStatus,
} from "./reconcile/reconcile.js";
export {
  fetchTransactions,
  fetchPaystackTransactions,
  fetchFlutterwaveTransactions,
  fetchStripePaymentIntents,
  parseTransactionFile,
  majorToMinor,
  type SourceOptions,
} from "./reconcile/sources.js";
