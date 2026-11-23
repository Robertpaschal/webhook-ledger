import type { Provider } from "../types.js";
import type { Transaction } from "./reconcile.js";

export interface SourceOptions {
  secretKey: string;
  from: Date;
  to: Date;
  /** Injected for tests. Defaults to global fetch (Node 18+). */
  fetch?: typeof fetch;
  /** Safety cap on pages fetched. Default 200. */
  maxPages?: number;
  baseUrl?: string;
}

type Json = Record<string, unknown>;

async function getJson(f: typeof fetch, url: string, secretKey: string): Promise<Json> {
  const res = await f(url, { headers: { Authorization: `Bearer ${secretKey}`, Accept: "application/json" } });
  if (!res.ok) {
    // Do not echo the body: some providers reflect request details.
    throw new Error(`GET ${new URL(url).pathname} failed with HTTP ${res.status}`);
  }
  return (await res.json()) as Json;
}

/** Convert a major-unit decimal (e.g. 1500.5) to minor units without float drift. */
export function majorToMinor(amount: number | string, decimals = 2): bigint {
  const s = typeof amount === "number" ? amount.toFixed(decimals) : amount;
  const [whole, frac = ""] = s.split(".");
  const sign = whole.startsWith("-") ? -1n : 1n;
  const digits = (whole.replace("-", "") || "0") + frac.padEnd(decimals, "0").slice(0, decimals);
  return sign * BigInt(digits);
}

/** Paystack: GET /transaction?from&to&perPage&page. Amounts are already in minor units. */
export async function fetchPaystackTransactions(opts: SourceOptions): Promise<Transaction[]> {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? "https://api.paystack.co";
  const out: Transaction[] = [];
  for (let page = 1; page <= (opts.maxPages ?? 200); page++) {
    const url = `${base}/transaction?perPage=100&page=${page}&from=${encodeURIComponent(opts.from.toISOString())}&to=${encodeURIComponent(opts.to.toISOString())}`;
    const body = await getJson(f, url, opts.secretKey);
    const data = Array.isArray(body.data) ? (body.data as Json[]) : [];
    for (const tx of data) {
      out.push({
        reference: String(tx.reference),
        amountMinor: BigInt(String(tx.amount)),
        currency: String(tx.currency),
        status: String(tx.status),
        occurredAt: tx.paid_at ? new Date(String(tx.paid_at)) : tx.created_at ? new Date(String(tx.created_at)) : undefined,
      });
    }
    const meta = (body.meta ?? {}) as Json;
    const pageCount = Number(meta.pageCount ?? 0);
    if (data.length === 0 || page >= pageCount) break;
  }
  return out;
}

/**
 * Flutterwave: GET /v3/transactions?from&to&page. Amounts are in major units;
 * they are converted with two decimals. Zero-decimal currencies need `decimals: 0`.
 */
export async function fetchFlutterwaveTransactions(opts: SourceOptions & { decimals?: number }): Promise<Transaction[]> {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? "https://api.flutterwave.com";
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const out: Transaction[] = [];
  for (let page = 1; page <= (opts.maxPages ?? 200); page++) {
    const url = `${base}/v3/transactions?from=${day(opts.from)}&to=${day(opts.to)}&page=${page}`;
    const body = await getJson(f, url, opts.secretKey);
    const data = Array.isArray(body.data) ? (body.data as Json[]) : [];
    for (const tx of data) {
      out.push({
        reference: String(tx.tx_ref),
        amountMinor: majorToMinor(tx.amount as number, opts.decimals ?? 2),
        currency: String(tx.currency),
        status: String(tx.status),
        occurredAt: tx.created_at ? new Date(String(tx.created_at)) : undefined,
      });
    }
    const info = (((body.meta ?? {}) as Json).page_info ?? {}) as Json;
    const total = Number(info.total_pages ?? 0);
    if (data.length === 0 || page >= total) break;
  }
  return out;
}

/** Stripe: GET /v1/payment_intents?created[gte]&created[lt]&limit=100, cursor-paginated. Reference is the PaymentIntent id. */
export async function fetchStripePaymentIntents(opts: SourceOptions): Promise<Transaction[]> {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? "https://api.stripe.com";
  const gte = Math.floor(opts.from.getTime() / 1000);
  const lt = Math.floor(opts.to.getTime() / 1000);
  const out: Transaction[] = [];
  let after: string | undefined;
  for (let page = 1; page <= (opts.maxPages ?? 200); page++) {
    const params = new URLSearchParams({ limit: "100", "created[gte]": String(gte), "created[lt]": String(lt) });
    if (after) params.set("starting_after", after);
    const body = await getJson(f, `${base}/v1/payment_intents?${params.toString()}`, opts.secretKey);
    const data = Array.isArray(body.data) ? (body.data as Json[]) : [];
    for (const pi of data) {
      out.push({
        reference: String(pi.id),
        amountMinor: BigInt(String(pi.amount)),
        currency: String(pi.currency).toUpperCase(),
        status: String(pi.status),
        occurredAt: typeof pi.created === "number" ? new Date(pi.created * 1000) : undefined,
      });
    }
    if (!body.has_more || data.length === 0) break;
    after = String(data[data.length - 1].id);
  }
  return out;
}

export function fetchTransactions(provider: Provider, opts: SourceOptions): Promise<Transaction[]> {
  switch (provider) {
    case "paystack":
      return fetchPaystackTransactions(opts);
    case "flutterwave":
      return fetchFlutterwaveTransactions(opts);
    case "stripe":
      return fetchStripePaymentIntents(opts);
  }
}

/** Parse an exported list (JSON array) of transactions for offline reconciliation. */
export function parseTransactionFile(text: string): Transaction[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Transaction file must be a JSON array.");
  return parsed.map((row, i) => {
    const r = row as Json;
    if (r.reference === undefined || r.amountMinor === undefined || !r.currency || !r.status) {
      throw new Error(`Row ${i}: needs reference, amountMinor, currency and status.`);
    }
    return {
      reference: String(r.reference),
      amountMinor: BigInt(String(r.amountMinor)),
      currency: String(r.currency),
      status: String(r.status),
      occurredAt: r.occurredAt ? new Date(String(r.occurredAt)) : undefined,
    };
  });
}
