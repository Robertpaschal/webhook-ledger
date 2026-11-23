import { describe, expect, it } from "vitest";
import {
  fetchFlutterwaveTransactions,
  fetchPaystackTransactions,
  fetchStripePaymentIntents,
  majorToMinor,
  normalizeStatus,
  parseTransactionFile,
  reconcile,
  type Transaction,
} from "../src/index.js";

const tx = (reference: string, amount: number, status = "success", currency = "NGN"): Transaction => ({
  reference,
  amountMinor: BigInt(amount),
  currency,
  status,
});

describe("reconcile", () => {
  it("reports each kind of planted drift and nothing else", () => {
    const ledger = [tx("ok-1", 1000), tx("amt", 1000), tx("cur", 1000, "success", "NGN"), tx("stat", 1000, "success"), tx("ghost", 500)];
    const remote = [
      tx("ok-1", 1000),
      tx("amt", 900),
      tx("cur", 1000, "success", "GHS"),
      tx("stat", 1000, "reversed"),
      tx("unrecorded", 2500),
      tx("abandoned-checkout", 3000, "abandoned"),
    ];
    const report = reconcile("paystack", ledger, remote);
    expect(report.matched).toBe(1);
    expect(report.drift.map((d) => [d.kind, d.reference]).sort()).toEqual(
      [
        ["amount_mismatch", "amt"],
        ["currency_mismatch", "cur"],
        ["missing_at_provider", "ghost"],
        ["missing_in_ledger", "unrecorded"],
        ["status_mismatch", "stat"],
      ].sort(),
    );
  });

  it("treats provider status vocabularies as equivalent", () => {
    expect(normalizeStatus("success")).toBe("succeeded");
    expect(normalizeStatus("successful")).toBe("succeeded");
    expect(normalizeStatus("succeeded")).toBe("succeeded");
    expect(normalizeStatus("something-new")).toBe("other");
    expect(reconcile("flutterwave", [tx("a", 1, "success")], [tx("a", 1, "successful")]).drift).toEqual([]);
  });

  it("converts major units without float drift", () => {
    expect(majorToMinor(0.1 + 0.2)).toBe(30n);
    expect(majorToMinor(1500.5)).toBe(150050n);
    expect(majorToMinor("19.99")).toBe(1999n);
    expect(majorToMinor(100, 0)).toBe(100n);
    expect(majorToMinor(-0.5)).toBe(-50n);
  });

  it("parses an exported transaction file and rejects incomplete rows", () => {
    expect(parseTransactionFile('[{"reference":"r","amountMinor":"5","currency":"NGN","status":"success"}]')[0].amountMinor).toBe(5n);
    expect(() => parseTransactionFile('[{"reference":"r"}]')).toThrow(/Row 0/);
    expect(() => parseTransactionFile("{}")).toThrow(/array/);
  });
});

function fakeFetch(pages: Record<string, unknown>, seen: string[]): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_x");
    const key = Object.keys(pages).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(pages[key]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const window = { secretKey: "sk_test_x", from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-08T00:00:00Z") };

describe("provider sources (recorded responses, no network)", () => {
  it("pages through Paystack transactions", async () => {
    const seen: string[] = [];
    const f = fakeFetch(
      {
        "page=1&": { data: [{ reference: "p1", amount: 10000, currency: "NGN", status: "success", paid_at: "2026-11-02T00:00:00Z" }], meta: { page: 1, pageCount: 2 } },
        "page=2&": { data: [{ reference: "p2", amount: 500, currency: "NGN", status: "abandoned", created_at: "2026-11-03T00:00:00Z" }], meta: { page: 2, pageCount: 2 } },
      },
      seen,
    );
    const out = await fetchPaystackTransactions({ ...window, fetch: f });
    expect(out.map((t) => [t.reference, t.amountMinor])).toEqual([["p1", 10000n], ["p2", 500n]]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("https://api.paystack.co/transaction?perPage=100&page=1&from=2026-11-01T00%3A00%3A00.000Z");
  });

  it("converts Flutterwave major-unit amounts", async () => {
    const seen: string[] = [];
    const f = fakeFetch(
      { "page=1": { data: [{ tx_ref: "f1", amount: 1500.5, currency: "NGN", status: "successful", created_at: "2026-11-02T00:00:00Z" }], meta: { page_info: { total_pages: 1, current_page: 1 } } } },
      seen,
    );
    const out = await fetchFlutterwaveTransactions({ ...window, fetch: f });
    expect(out).toEqual([{ reference: "f1", amountMinor: 150050n, currency: "NGN", status: "successful", occurredAt: new Date("2026-11-02T00:00:00Z") }]);
    expect(seen[0]).toBe("https://api.flutterwave.com/v3/transactions?from=2026-11-01&to=2026-11-08&page=1");
  });

  it("follows Stripe cursors", async () => {
    const seen: string[] = [];
    const f = fakeFetch(
      {
        "starting_after=pi_2": { data: [{ id: "pi_3", amount: 300, currency: "usd", status: "canceled", created: 1762000000 }], has_more: false },
        "payment_intents?limit": { data: [{ id: "pi_1", amount: 100, currency: "usd", status: "succeeded", created: 1762000000 }, { id: "pi_2", amount: 200, currency: "usd", status: "succeeded", created: 1762000000 }], has_more: true },
      },
      seen,
    );
    const out = await fetchStripePaymentIntents({ ...window, fetch: f });
    expect(out.map((t) => t.reference)).toEqual(["pi_1", "pi_2", "pi_3"]);
    expect(out[0].currency).toBe("USD");
  });

  it("fails loudly on HTTP errors without echoing the response body", async () => {
    const f = (async () => new Response("secret-ish detail", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchPaystackTransactions({ ...window, fetch: f })).rejects.toThrow("GET /transaction failed with HTTP 401");
  });
});
