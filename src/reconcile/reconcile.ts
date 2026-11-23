import type { Provider } from "../types.js";
import type { SqlClient } from "../ledger/ledger.js";

export type NormalizedStatus = "succeeded" | "failed" | "pending" | "refunded" | "other";

export interface Transaction {
  reference: string;
  amountMinor: bigint;
  currency: string;
  status: string;
  occurredAt?: Date;
}

export type DriftKind =
  | "missing_in_ledger"
  | "missing_at_provider"
  | "amount_mismatch"
  | "currency_mismatch"
  | "status_mismatch";

export interface Drift {
  kind: DriftKind;
  reference: string;
  ledger?: Transaction;
  provider?: Transaction;
}

export interface ReconcileReport {
  provider: Provider;
  checked: { ledger: number; provider: number };
  matched: number;
  drift: Drift[];
}

const STATUS_MAP: Record<string, NormalizedStatus> = {
  // Paystack
  success: "succeeded",
  failed: "failed",
  abandoned: "failed",
  reversed: "refunded",
  ongoing: "pending",
  pending: "pending",
  processing: "pending",
  queued: "pending",
  // Flutterwave
  successful: "succeeded",
  cancelled: "failed",
  // Stripe PaymentIntent
  succeeded: "succeeded",
  canceled: "failed",
  requires_payment_method: "pending",
  requires_confirmation: "pending",
  requires_action: "pending",
  requires_capture: "pending",
  refunded: "refunded",
};

export function normalizeStatus(status: string): NormalizedStatus {
  return STATUS_MAP[status.trim().toLowerCase()] ?? "other";
}

/**
 * Compare what the application recorded against what the provider reports.
 *
 * A provider transaction only counts as `missing_in_ledger` when it
 * succeeded: abandoned checkouts are normal and are not drift.
 */
export function reconcile(provider: Provider, ledger: Transaction[], remote: Transaction[]): ReconcileReport {
  const byRef = new Map<string, Transaction>();
  for (const tx of remote) byRef.set(tx.reference, tx);
  const seen = new Set<string>();
  const drift: Drift[] = [];
  let matched = 0;

  for (const local of ledger) {
    const other = byRef.get(local.reference);
    seen.add(local.reference);
    if (!other) {
      drift.push({ kind: "missing_at_provider", reference: local.reference, ledger: local });
      continue;
    }
    let ok = true;
    if (local.currency.toUpperCase() !== other.currency.toUpperCase()) {
      drift.push({ kind: "currency_mismatch", reference: local.reference, ledger: local, provider: other });
      ok = false;
    } else if (local.amountMinor !== other.amountMinor) {
      drift.push({ kind: "amount_mismatch", reference: local.reference, ledger: local, provider: other });
      ok = false;
    }
    if (normalizeStatus(local.status) !== normalizeStatus(other.status)) {
      drift.push({ kind: "status_mismatch", reference: local.reference, ledger: local, provider: other });
      ok = false;
    }
    if (ok) matched++;
  }

  for (const tx of remote) {
    if (seen.has(tx.reference)) continue;
    if (normalizeStatus(tx.status) === "succeeded") {
      drift.push({ kind: "missing_in_ledger", reference: tx.reference, provider: tx });
    }
  }

  return { provider, checked: { ledger: ledger.length, provider: remote.length }, matched, drift };
}

export async function loadLedgerTransactions(
  db: SqlClient,
  provider: Provider,
  from: Date,
  to: Date,
): Promise<Transaction[]> {
  const { rows } = await db.query(
    `SELECT reference, amount_minor::text AS amount_minor, currency, status, occurred_at
       FROM payment_records
      WHERE provider = $1 AND occurred_at >= $2 AND occurred_at < $3
      ORDER BY occurred_at`,
    [provider, from, to],
  );
  return rows.map((r) => ({
    reference: String(r.reference),
    amountMinor: BigInt(String(r.amount_minor)),
    currency: String(r.currency),
    status: String(r.status),
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at : new Date(String(r.occurred_at)),
  }));
}

function jsonSafe(tx: Transaction | undefined) {
  if (!tx) return undefined;
  return { ...tx, amountMinor: tx.amountMinor.toString(), occurredAt: tx.occurredAt?.toISOString() };
}

export function reportToJson(report: ReconcileReport): string {
  return JSON.stringify(
    {
      ...report,
      drift: report.drift.map((d) => ({ ...d, ledger: jsonSafe(d.ledger), provider: jsonSafe(d.provider) })),
    },
    null,
    2,
  );
}

export function formatReport(report: ReconcileReport): string {
  const lines = [
    `${report.provider}: ${report.checked.ledger} ledger rows, ${report.checked.provider} provider transactions, ${report.matched} matched, ${report.drift.length} drift`,
  ];
  for (const d of report.drift) {
    const l = d.ledger ? `${d.ledger.amountMinor} ${d.ledger.currency} ${d.ledger.status}` : "-";
    const p = d.provider ? `${d.provider.amountMinor} ${d.provider.currency} ${d.provider.status}` : "-";
    lines.push(`  ${d.kind.padEnd(20)} ${d.reference}  ledger=${l}  provider=${p}`);
  }
  return lines.join("\n");
}
