// Payload shapes modelled on each provider's documented examples, with
// invented ids and amounts. No real keys, customers or money.

export const paystackChargeSuccess = JSON.stringify({
  event: "charge.success",
  data: {
    id: 302961,
    domain: "test",
    status: "success",
    reference: "qTPrJoy9Bx",
    amount: 1000000,
    currency: "NGN",
    paid_at: "2026-11-20T09:14:00.000Z",
    channel: "card",
    customer: { id: 68324, email: "customer@example.com" },
  },
});

export const paystackTransferSuccess = JSON.stringify({
  event: "transfer.success",
  data: { amount: 30000, currency: "NGN", reference: "trf_ref_01", transfer_code: "TRF_1ptvuv321ahaa7q", status: "success" },
});

export const flutterwaveChargeCompleted = JSON.stringify({
  event: "charge.completed",
  data: {
    id: 285959875,
    tx_ref: "Links-616626414629",
    flw_ref: "PeterEkene/FLW270177170",
    amount: 100,
    currency: "NGN",
    status: "successful",
    created_at: "2026-11-20T10:04:13.000Z",
  },
  "event.type": "CARD_TRANSACTION",
});

export const stripePaymentIntentSucceeded = JSON.stringify({
  id: "evt_3TestEventId0001",
  object: "event",
  type: "payment_intent.succeeded",
  created: 1764000000,
  data: { object: { id: "pi_3TestIntent0001", object: "payment_intent", amount: 2000, currency: "usd", status: "succeeded" } },
});
