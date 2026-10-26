// Deterministic guardrail on the model's report. Fails (exit 1) if the report cites a
// finding that does not exist, contains a URL not in the findings, mentions a forbidden
// path, drops required sections, or is too long. Enforced in code, not by prompt wording.
// Usage: node scripts/check-report.mjs <report.md> <findings.json> <site-audit.config.yml>
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const [reportPath, findingsPath, configPath] = process.argv.slice(2);
if (!configPath) {
  console.error("Usage: check-report.mjs <report.md> <findings.json> <config.yml>");
  process.exit(2);
}
const report = readFileSync(reportPath, "utf8");
const findings = JSON.parse(readFileSync(findingsPath, "utf8"));
const config = parse(readFileSync(configPath, "utf8"));
const errors = [];

const known = new Set([...findings.findings.map((f) => f.id), ...findings.diff.resolved.map((r) => r.id), ...(findings.diff.reopened ?? []).map((r) => r.id)]);
for (const id of new Set(report.match(/F-[0-9a-f]{6}/g) ?? [])) {
  if (!known.has(id)) errors.push(`cites unknown finding ${id}`);
}

const dataText = JSON.stringify(findings) + " " + config.site.url;
for (const url of new Set(report.match(/https?:\/\/[^\s)>\]"'`]+/g) ?? [])) {
  const clean = url.replace(/[.,;:]+$/, "");
  if (!dataText.includes(clean)) errors.push(`URL not present in findings: ${clean}`);
}

for (const p of config.scope.forbidden_paths) {
  const needle = p.replace(/\*+$/, ""); // ".env*" -> ".env"
  if (needle && report.includes(needle)) errors.push(`mentions forbidden path ${p}`);
}

for (const h of ["## Summary", "## Findings", "## Resolved since last run", "## Notes"]) {
  if (!report.includes(h)) errors.push(`missing section ${h}`);
}
if (!/<!-- ledger-notes: [^\n]*-->\s*$/.test(report)) errors.push("missing final ledger-notes comment");
const top3 = /<!-- top3: ([^>]*?) -->\s*<!-- ledger-notes:/.exec(report);
if (!top3) errors.push("missing top3 comment before the ledger-notes comment");
else if (top3[1].split(",").map((x) => x.trim()).some((id) => !findings.findings.some((f) => f.id === id))) errors.push("top3 comment cites an unknown finding");
if (report.split(/\s+/).length > 1200) errors.push("report too long");

if (errors.length) {
  for (const e of errors) console.log(`::error::${e}`);
  process.exit(1);
}
console.error("Report passed checks");
