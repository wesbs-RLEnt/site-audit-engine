// Builds the ledger entry (design doc section 7.2) from findings.json, the raw check
// results and the report's ledger-notes comment. Deterministic; no model involved.
// Usage: node scripts/ledger-entry.mjs <findings.json> <results-dir> <report.md> [usage.json]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [findingsPath, resultsDir, reportPath, usagePath] = process.argv.slice(2);
const f = JSON.parse(readFileSync(findingsPath, "utf8"));
const report = readFileSync(reportPath, "utf8");
const lines = [`## ${f.date}`];

if (f.scores) {
  const s = f.scores;
  lines.push(`- Scores: perf ${s.performance} | seo ${s.seo} | a11y ${s.accessibility} | best-practices ${s["best-practices"]}`);
}
const rvrPath = join(resultsDir, "raw-vs-rendered.json");
if (existsSync(rvrPath)) {
  const r = JSON.parse(readFileSync(rvrPath, "utf8"));
  const bad = r.results.filter((p) => (p.flags ?? []).some((x) => x.type === "missing_in_raw_html" || (x.type === "missing" && x.field === "title"))).length;
  lines.push(`- Raw-HTML check: ${bad}/${r.pages_checked} pages missing title/description in raw HTML`);
}
const top = f.findings.filter((x) => x.severity === "critical" || x.severity === "high").slice(0, 8);
lines.push(`- Proposed: ${top.map((x) => `[${x.id}] ${x.title} (${x.fix_class})`).join(", ") || "none critical/high"}`);
lines.push(`- Severity counts: ${Object.entries(f.severity_counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
lines.push(`- Reopened: ${(f.diff.reopened ?? []).map((r) => `[${r.id}]`).join(", ") || "none"}`);
lines.push(`- Resolved since last run: ${f.diff.resolved.map((r) => `[${r.id}]`).join(", ") || "none"}`);
if (usagePath && existsSync(usagePath)) {
  const u = JSON.parse(readFileSync(usagePath, "utf8"));
  lines.push(`- Claude usage: ${u.input_tokens} in / ${u.output_tokens} out tokens (${u.model})`);
}
const notes = /<!-- ledger-notes: (.*?) -->/.exec(report)?.[1] ?? "";
lines.push(`- Notes: ${notes.replace(/[\r\n]+/g, " ").slice(0, 400)}`);
console.log(lines.join("\n") + "\n");
