// Builds the GitHub Pages site from README.md so the docs cannot drift from it.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { marked } from "marked";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  // The badge and docs link point at this site; drop them from the page itself.
  .replace(/^\[!\[CI\].*\n/m, "")
  .replace(/^Docs: https:\/\/robertpaschal\.github\.io\/webhook-ledger\/\n\n/m, "");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const body = marked.parse(readme, { gfm: true });

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>webhook-ledger: verified, idempotent payment webhooks</title>
<meta name="description" content="${pkg.description}">
<style>
:root { --bg:#fbfaf7; --fg:#1d1b18; --muted:#5e5a53; --line:#e4e0d8; --code:#f2efe8; --accent:#0f6b4f; }
@media (prefers-color-scheme: dark) { :root { --bg:#15140f; --fg:#ece8df; --muted:#a8a296; --line:#2e2b25; --code:#211f19; --accent:#5fd0a5; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 80px; }
header.top { display:flex; flex-wrap:wrap; gap:12px 20px; align-items:baseline; justify-content:space-between; border-bottom:1px solid var(--line); padding-bottom:12px; margin-bottom:8px; font-size:14px; color:var(--muted); }
header.top a { color: var(--accent); }
h1 { font-size: 2.1rem; margin: 24px 0 8px; letter-spacing:-0.02em; }
h2 { margin-top: 2.4em; padding-top: 0.4em; border-top: 1px solid var(--line); }
a { color: var(--accent); }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 0.1em 0.35em; border-radius: 4px; }
pre { background: var(--code); padding: 14px 16px; border-radius: 8px; overflow-x: auto; border:1px solid var(--line); }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; display:block; overflow-x:auto; font-size: 0.93em; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--code); }
</style>
</head>
<body>
<main>
<header class="top"><span>v${pkg.version} · MIT</span><span><a href="playground/">Playground</a> · <a href="https://github.com/Robertpaschal/webhook-ledger">GitHub</a> · <a href="https://www.npmjs.com/package/webhook-ledger">npm</a> · <a href="https://github.com/Robertpaschal/webhook-ledger/issues">Issues</a></span></header>
${body}
</main>
</body>
</html>
`;
mkdirSync(new URL("../site/", import.meta.url), { recursive: true });
writeFileSync(new URL("../site/index.html", import.meta.url), html);
writeFileSync(new URL("../site/.nojekyll", import.meta.url), "");
// The playground is static: an HTML page and the Web Crypto module it imports.
cpSync(new URL("../docs/playground/", import.meta.url), new URL("../site/playground/", import.meta.url), { recursive: true });
console.log("site/index.html and site/playground/ written");
