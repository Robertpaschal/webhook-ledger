import { createHmac } from "node:crypto";
import pg from "pg";
import { describe } from "vitest";

export const NOW = 1_764_000_000; // fixed clock for signature tests

export function signPaystackV2(body: string, secret: string, t = NOW, keyId = "key_1"): string {
  const hex = createHmac("sha512", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${keyId}:${hex}`;
}

export function signPaystackLegacy(body: string, secretKey: string): string {
  return createHmac("sha512", secretKey).update(body).digest("hex");
}

export function signStripe(body: string, secret: string, t = NOW): string {
  const hex = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${hex}`;
}

export const POSTGRES_URL = process.env.POSTGRES_URL;

/**
 * Database suites run against a real Postgres. Locally they skip without
 * POSTGRES_URL; in CI a missing URL is an error, so the suite can never
 * pass by silently running nothing.
 */
export function describeDb(name: string, fn: () => void) {
  if (!POSTGRES_URL && process.env.CI) {
    throw new Error(`POSTGRES_URL is required in CI for "${name}"`);
  }
  return describe.skipIf(!POSTGRES_URL)(name, fn);
}

export async function freshSchema(): Promise<{ pool: pg.Pool; schema: string; drop: () => Promise<void> }> {
  const schema = `wl_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Pool({ connectionString: POSTGRES_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: POSTGRES_URL, options: `-c search_path=${schema}`, max: 12 });
  return {
    pool,
    schema,
    drop: async () => {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
