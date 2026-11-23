import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Provider } from "./types.js";
import { migrate, type SqlPool } from "./ledger/ledger.js";
import { formatReport, loadLedgerTransactions, reconcile, reportToJson } from "./reconcile/reconcile.js";
import { fetchTransactions, parseTransactionFile } from "./reconcile/sources.js";

const USAGE = `webhook-ledger <command> [options]

Commands
  migrate     Create the webhook_events and payment_records tables (idempotent).
  reconcile   Compare payment_records with the provider's transactions and report drift.

Options
  --database-url <url>   Postgres URL (default: $DATABASE_URL)
  --provider <name>      paystack | flutterwave | stripe       (reconcile)
  --from <date>          Start, inclusive, ISO date or datetime (reconcile)
  --to <date>            End, exclusive, ISO date or datetime   (reconcile)
  --input <file>         Read provider transactions from a JSON file instead of the API
  --json                 Print the report as JSON

Provider API keys come from the environment only:
  PAYSTACK_SECRET_KEY, FLUTTERWAVE_SECRET_KEY, STRIPE_SECRET_KEY

Exit codes: 0 no drift, 1 drift found, 2 usage or runtime error.`;

const KEY_ENV: Record<Provider, string> = {
  paystack: "PAYSTACK_SECRET_KEY",
  flutterwave: "FLUTTERWAVE_SECRET_KEY",
  stripe: "STRIPE_SECRET_KEY",
};

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Injected for tests; defaults to a pg.Pool. */
  createPool?: (url: string) => Promise<SqlPool & { end(): Promise<void> }>;
  fetch?: typeof fetch;
}

async function defaultPool(url: string) {
  let pg: typeof import("pg");
  try {
    pg = (await import("pg")).default as unknown as typeof import("pg");
  } catch {
    throw new Error("The CLI needs the 'pg' package: npm install pg");
  }
  return new pg.Pool({ connectionString: url }) as unknown as SqlPool & { end(): Promise<void> };
}

function parseDate(value: string | undefined, name: string): Date {
  if (!value) throw new Error(`--${name} is required`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`--${name} is not a valid date: ${value}`);
  return d;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "database-url": { type: "string" },
        provider: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        input: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    io.err((err as Error).message);
    io.err(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help || !command) {
    (values.help ? io.out : io.err)(USAGE);
    return values.help ? 0 : 2;
  }

  const dbUrl = values["database-url"] ?? io.env.DATABASE_URL;
  if (!dbUrl) {
    io.err("Set --database-url or DATABASE_URL.");
    return 2;
  }

  let pool: (SqlPool & { end(): Promise<void> }) | undefined;
  try {
    if (command === "migrate") {
      pool = await (io.createPool ?? defaultPool)(dbUrl);
      await migrate(pool);
      io.out("webhook-ledger: schema is up to date.");
      return 0;
    }
    if (command === "reconcile") {
      const provider = values.provider as Provider | undefined;
      if (!provider || !(provider in KEY_ENV)) throw new Error("--provider must be paystack, flutterwave or stripe");
      const from = parseDate(values.from, "from");
      const to = parseDate(values.to, "to");
      if (to <= from) throw new Error("--to must be after --from");

      let remote;
      if (values.input) {
        remote = parseTransactionFile(readFileSync(values.input, "utf8"));
      } else {
        const secretKey = io.env[KEY_ENV[provider]];
        if (!secretKey) throw new Error(`Set ${KEY_ENV[provider]}, or pass --input with an exported transaction list.`);
        remote = await fetchTransactions(provider, { secretKey, from, to, fetch: io.fetch });
      }
      pool = await (io.createPool ?? defaultPool)(dbUrl);
      const local = await loadLedgerTransactions(pool, provider, from, to);
      const report = reconcile(provider, local, remote);
      io.out(values.json ? reportToJson(report) : formatReport(report));
      return report.drift.length > 0 ? 1 : 0;
    }
    io.err(`Unknown command: ${command}`);
    io.err(USAGE);
    return 2;
  } catch (err) {
    io.err(`webhook-ledger: ${(err as Error).message}`);
    return 2;
  } finally {
    await pool?.end();
  }
}
