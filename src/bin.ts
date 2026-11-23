import { runCli } from "./cli.js";

runCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`webhook-ledger: ${(err as Error).message}\n`);
    process.exitCode = 2;
  },
);
