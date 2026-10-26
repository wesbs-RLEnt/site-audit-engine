// Builds the short Slack notification (JSON on stdout). The full report stays in the issue.
// Only deterministic fields are used (rule-based titles, counts, scores), never model text.
// Usage: node scripts/slack-message.mjs <findings.json> <issue-url> [report.md]
// The top 3 comes from the report's <!-- top3: ... --> line (ids validated against the
// findings); without it, the first three by severity.
import { existsSync, readFileSync } from "node:fs";

const [findingsPath, issueUrl, reportPath] = process.argv.slice(2);
const f = JSON.parse(readFileSync(findingsPath, "utf8"));
// Slack mrkdwn control characters
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const c = f.severity_counts;
const dot = { critical: ":red_circle:", high: ":large_orange_circle:", medium: ":large_yellow_circle:", low: ":white_circle:" };
let picked = [];
if (reportPath && existsSync(reportPath)) {
  const m = /<!-- top3: ([^>]*?) -->/.exec(readFileSync(reportPath, "utf8"));
  if (m) picked = m[1].split(",").map((id) => f.findings.find((x) => x.id === id.trim())).filter(Boolean);
}
if (!picked.length) picked = f.findings.slice(0, 3);
const top = picked.slice(0, 3).map((x) => `${dot[x.severity] ?? ""} ${esc(x.title)}`).join("\n");
const s = f.scores;
const lines = [
  `*Site audit: ${esc(f.site)}* (${esc(f.date)})`,
  `Critical ${c.critical} | High ${c.high} | Medium ${c.medium} | Low ${c.low}`,
  s ? `Perf ${s.performance} | SEO ${s.seo} | A11y ${s.accessibility} | Best practices ${s["best-practices"]}` : null,
  f.diff.first_run ? "First run, no comparison yet" : `New ${f.diff.new.length} | Reopened ${(f.diff.reopened ?? []).length} | Resolved ${f.diff.resolved.length}`,
  "",
  "*Top findings*",
  top,
  "",
  `<${issueUrl}|Read the full report>`,
].filter((l) => l !== null);
console.log(JSON.stringify({ text: `Site audit: ${f.site} (${f.date})`, blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }] }));
