// Sends the same signed Paystack event twice: the first is processed, the second is a duplicate.
import { createHmac } from "node:crypto";

const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
if (!secret) throw new Error("Set PAYSTACK_WEBHOOK_SECRET to the value the server uses.");

const body = JSON.stringify({
  event: "charge.success",
  data: { id: Date.now(), reference: `example-${Date.now()}`, amount: 500000, currency: "NGN", status: "success" },
});
const t = Math.floor(Date.now() / 1000);
const sig = createHmac("sha512", secret).update(`${t}.${body}`).digest("hex");

for (let i = 0; i < 2; i++) {
  const res = await fetch("http://localhost:3000/webhooks/paystack", {
    method: "POST",
    headers: { "content-type": "application/json", "paystack-signature": `t=${t},v1=example:${sig}` },
    body,
  });
  console.log(res.status, await res.json());
}
