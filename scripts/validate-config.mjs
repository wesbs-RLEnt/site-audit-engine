// Validates a site-audit config. On success prints key=value lines (url, sitemap, name)
// suitable for appending to $GITHUB_OUTPUT. Errors use GitHub's ::error:: format.
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const path = process.argv[2];
if (!path || !existsSync(path)) {
  console.log(`::error::No config found at ${path}`);
  process.exit(1);
}
const c = parse(readFileSync(path, "utf8")) ?? {};
const errors = [];
const site = c.site ?? {};
for (const k of ["name", "url", "stack"]) if (!site[k]) errors.push(`site.${k} is required`);
if (site.url && !String(site.url).startsWith("https://")) errors.push("site.url must start with https://");
if (!["lovable-vite", "react-ssr", "wordpress", "other"].includes(site.stack)) errors.push("site.stack must be lovable-vite | react-ssr | wordpress | other");
if ((c.autonomy ?? "report") !== "report") errors.push("autonomy must be 'report' in the MVP");
for (const k of ["allowed_paths", "forbidden_paths"]) if (!Array.isArray(c.scope?.[k])) errors.push(`scope.${k} must be a list`);
if (errors.length) {
  for (const e of errors) console.log(`::error::${e}`);
  process.exit(1);
}
console.error("Config valid");
console.log(`name=${site.name}`);
console.log(`url=${site.url}`);
console.log(`sitemap=${site.sitemap ?? "/sitemap.xml"}`);
