// Merges check outputs into one findings.json for the agent.
// Everything here is deterministic: IDs, severities, fix classes, dedupe and the
// new/resolved/persisting diff. Claude only interprets and writes up the result.
//
// Usage: node scripts/condense.mjs --results <dir> --config <site-audit.config.yml>
//          [--previous <state.json>] [--out findings.json] [--state state.json] [--date YYYY-MM-DD]
// <dir> holds raw-vs-rendered.json, site-files.json, links-and-alt.json, lighthouse.json, deps.json
// (any may be missing; a missing check is reported, not fatal).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const resultsDir = opt("--results");
const configPath = opt("--config");
if (!resultsDir || !configPath) {
  console.error("Usage: condense.mjs --results <dir> --config <file> [--previous state.json] [--out findings.json] [--state state.json]");
  process.exit(2);
}
const date = opt("--date", new Date().toISOString().slice(0, 10));
const config = parseYaml(readFileSync(configPath, "utf8"));
const previous = opt("--previous") && existsSync(opt("--previous")) ? JSON.parse(readFileSync(opt("--previous"), "utf8")) : null;

const NOISE_POINTS = 5; // score moves smaller than this are treated as noise
const MAX_FINDINGS = 40; // cap on what goes to Claude; the rest are counted, not listed
const SEV = ["critical", "high", "medium", "low"];

const load = (f) => {
  const p = join(resultsDir, f);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const rvr = load("raw-vs-rendered.json");
const files = load("site-files.json");
const links = load("links-and-alt.json");
const lh = load("lighthouse.json");
const deps = load("deps.json");

const idFor = (key) => "F-" + createHash("sha1").update(key).digest("hex").slice(0, 6);
const byKey = new Map();
function add(key, f) {
  if (byKey.has(key)) return;
  byKey.set(key, { id: idFor(key), key, ...f });
}
const max = (a, b) => (SEV.indexOf(a) <= SEV.indexOf(b) ? a : b);
const list = (xs, n = 5) => [...new Set(xs)].slice(0, n);

// ---------- raw vs rendered ----------
if (rvr) {
  const RVR = {
    "missing_in_raw_html:title": ["high", "auto-safe", "Title only appears after JavaScript runs; crawlers and previews will not see it"],
    "missing_in_raw_html:meta description": ["high", "auto-safe", "Meta description only appears after JavaScript runs"],
    "missing_in_raw_html:canonical": ["medium", "auto-safe", "Canonical tag only appears after JavaScript runs"],
    "missing:title": ["high", "auto-safe", "Page has no title"],
    "missing:meta description": ["medium", "auto-safe", "Page has no meta description"],
    "missing:canonical": ["medium", "auto-safe", "Page has no canonical link"],
    "missing:og:title": ["low", "auto-safe", "Missing og:title"],
    "missing:og:description": ["low", "auto-safe", "Missing og:description"],
    "missing:og:image": ["low", "auto-safe", "Missing og:image, so social previews have no image"],
    "relative_url:canonical": ["medium", "auto-safe", "Canonical URL is relative; it must be absolute"],
  };
  const groups = new Map();
  for (const r of rvr.results) {
    if (r.error) {
      add(`rvr:error:${r.url}`, { severity: "medium", fix_class: "needs-approval", category: "Technical SEO", title: "Page could not be checked", evidence: { url: r.url, error: r.error } });
      continue;
    }
    for (const f of r.flags) {
      let k;
      if (f.type === "h1_count") k = "h1_count";
      else if (f.type === "thin_raw_html") k = "thin_raw_html";
      else if (f.type === "relative_url") k = `relative_url:${f.field}`;
      else k = `${f.type}:${f.field}`;
      groups.set(k, [...(groups.get(k) ?? []), { url: r.url, ...f }]);
    }
  }
  for (const [k, hits] of groups) {
    const pages = hits.map((h) => h.url);
    let spec = RVR[k];
    if (k === "h1_count") spec = ["medium", "needs-approval", "Page does not have exactly one H1"];
    if (k === "thin_raw_html") spec = ["high", "needs-approval", "Raw HTML has far less content than the rendered page"];
    if (!spec) continue;
    add(`rvr:${k}`, {
      severity: spec[0], fix_class: spec[1], category: "Technical SEO", title: spec[2],
      evidence: { pages_affected: new Set(pages).size, examples: list(pages, 3) },
    });
  }
  for (const d of rvr.duplicate_titles ?? []) {
    add(`rvr:dup_title:${d.title}`, { severity: "medium", fix_class: "auto-safe", category: "Technical SEO", title: "Duplicate page title", evidence: { title: d.title, pages: d.pages.slice(0, 5) } });
  }
}

// ---------- site files + headers ----------
if (files) {
  const HEADER_SEV = {
    "Strict-Transport-Security": "high", "Content-Security-Policy": "medium",
    "X-Frame-Options (or CSP frame-ancestors)": "low", "X-Content-Type-Options": "low",
    "Referrer-Policy": "low", "Permissions-Policy": "low",
  };
  const SF = {
    robots_missing: ["medium", "auto-safe", "robots.txt is missing", "public/robots.txt"],
    robots_blocks_all: ["critical", "needs-approval", "robots.txt blocks the whole site", "public/robots.txt"],
    robots_no_sitemap_line: ["low", "auto-safe", "robots.txt has no Sitemap: line", "public/robots.txt"],
    sitemap_missing: ["high", "auto-safe", "sitemap.xml is missing", "public/sitemap.xml"],
    sitemap_empty: ["high", "auto-safe", "sitemap.xml lists no URLs", "public/sitemap.xml"],
    sitemap_relative_urls: ["medium", "auto-safe", "sitemap.xml uses relative URLs; they must be absolute", "public/sitemap.xml"],
    sitemap_other_host: ["medium", "auto-safe", "sitemap.xml lists URLs on a different host", "public/sitemap.xml"],
    sitemap_url_not_200: ["medium", "needs-approval", "Sitemap lists a URL that does not return 200", null],
    no_https_redirect: ["high", "needs-approval", "HTTP does not redirect to HTTPS", null],
    http_unreachable: ["low", "needs-approval", "HTTP version of the site is unreachable", null],
    hsts_short: ["medium", "auto-safe", "HSTS max-age is too short", "public/_headers"],
  };
  for (const f of files.findings) {
    if (f.check === "header_missing") {
      const sev = HEADER_SEV[f.header] ?? "low";
      add(`files:header:${f.header}`, {
        severity: sev, category: "Security/Maintenance",
        fix_class: f.header === "Content-Security-Policy" ? "needs-approval" : "auto-safe",
        title: `Missing security header: ${f.header}`, evidence: { header: f.header }, fix_hint: "public/_headers",
      });
      continue;
    }
    const spec = SF[f.check];
    if (!spec) continue;
    const { check, ...evidence } = f;
    add(`files:${f.check}${f.check === "sitemap_url_not_200" ? ":" + f.url : ""}`, {
      severity: spec[0], fix_class: spec[1], category: f.check.startsWith("no_https") || f.check.startsWith("hsts") ? "Security/Maintenance" : "Technical SEO",
      title: spec[2], evidence, ...(spec[3] ? { fix_hint: spec[3] } : {}),
    });
  }
}

// ---------- links, alt text, images ----------
if (links) {
  const alt = links.findings.filter((f) => f.check === "img_missing_alt");
  if (alt.length) add("links:img_missing_alt", { severity: "medium", fix_class: "auto-safe", category: "Technical SEO", title: "Images missing alt text", evidence: { count: alt.length, examples: alt.slice(0, 5).map((a) => ({ page: a.page, src: a.src })) } });
  const big = links.findings.filter((f) => f.check === "oversized_image").sort((a, b) => b.bytes - a.bytes);
  if (big.length) add("links:oversized_image", { severity: "medium", fix_class: "auto-safe", category: "Performance", title: "Oversized images", evidence: { count: big.length, limit_bytes: big[0].limit, largest: big.slice(0, 5).map((b) => ({ url: b.url, bytes: b.bytes })) } });
  for (const f of links.findings) {
    if (["broken_internal_link", "broken_image", "page_not_200"].includes(f.check)) {
      const t = { broken_internal_link: "Broken internal link", broken_image: "Broken image", page_not_200: "Sitemap page does not return 200" }[f.check];
      add(`links:${f.check}:${f.url}`, { severity: f.check === "page_not_200" ? "high" : "medium", fix_class: f.check === "broken_internal_link" ? "auto-safe" : "needs-approval", category: "Technical SEO", title: t, evidence: { url: f.url, status: f.status ?? f.error, found_on: f.found_on } });
    }
  }
}

// ---------- lighthouse ----------
const scoreDeltas = {};
if (lh && lh.pages[0]) {
  const p = lh.pages[0];
  const th = config.audit?.thresholds ?? {};
  const map = { performance: "lighthouse_performance", seo: "lighthouse_seo", accessibility: "lighthouse_accessibility" };
  for (const [cat, tk] of Object.entries(map)) {
    const score = p.scores[cat], threshold = th[tk];
    // Hysteresis: a finding opens when the score drops below the threshold, but once open it
    // only resolves when the score clears the threshold by the noise margin. Otherwise a score
    // hovering near the threshold would flip the finding on and off from run to run.
    const key = `lh:score:${cat}`;
    const wasOpen = !!previous?.findings?.[idFor(key)];
    if (threshold !== undefined && (score < threshold || (wasOpen && score < threshold + NOISE_POINTS))) {
      add(key, {
        severity: threshold - score >= 20 ? "high" : "medium", fix_class: "needs-approval",
        category: cat === "performance" ? "Performance" : "Technical SEO",
        title: `Lighthouse ${cat} score below threshold`,
        evidence: { score, threshold, resolves_at_or_above: threshold + NOISE_POINTS, run_spread: p.spread[cat], metrics_ms: cat === "performance" ? Object.fromEntries(Object.entries(p.metrics).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) : undefined },
      });
    }
  }
  for (const a of p.failing_audits.filter((a) => a.category !== "performance")) {
    add(`lh:audit:${a.id}`, { severity: "low", fix_class: "needs-approval", category: a.category === "seo" ? "Technical SEO" : "Performance", title: `Lighthouse audit failing: ${a.title}`, evidence: { audit: a.id, category: a.category, score: a.score, page: p.url } });
  }
}

// ---------- dependencies ----------
if (deps && !deps.skipped) {
  const SEVMAP = { critical: "critical", high: "high", moderate: "medium", low: "low" };
  const byPkg = new Map();
  for (const v of deps.vulnerabilities) byPkg.set(v.package, [...(byPkg.get(v.package) ?? []), v]);
  for (const [pkg, vs] of byPkg) {
    const sev = vs.reduce((s, v) => max(s, SEVMAP[v.severity] ?? "low"), "low");
    add(`deps:vuln:${pkg}`, {
      severity: sev, fix_class: "needs-approval", category: "Security/Maintenance",
      title: `Vulnerable dependency: ${pkg}`,
      evidence: { direct: vs[0].direct, installed: vs[0].installed, advisory_count: new Set(vs.map((v) => v.url)).size, advisories: list(vs.map((v) => v.title), 3), urls: list(vs.map((v) => v.url), 3) },
      note: "Verify exploitability before acting; advisory data comes from the npm registry.",
    });
  }
  for (const kind of ["patch", "minor", "major"]) {
    const items = deps.outdated.filter((o) => o.update === kind);
    if (!items.length) continue;
    add(`deps:outdated:${kind}`, {
      severity: "low", fix_class: kind === "patch" ? "auto-safe" : "needs-approval", category: "Security/Maintenance",
      title: `${items.length} direct dependencies have ${kind} updates`,
      evidence: { count: items.length, examples: items.slice(0, 8).map((o) => `${o.package} ${o.installed} -> ${o.latest}`) },
    });
  }
}

// ---------- diff vs previous run ----------
const all = [...byKey.values()];
const prevIds = new Set(Object.keys(previous?.findings ?? {}));
const curIds = new Set(all.map((f) => f.id));
for (const f of all) f.first_seen = previous?.findings?.[f.id]?.first_seen ?? date;
const diff = {
  first_run: !previous,
  new: all.filter((f) => !prevIds.has(f.id)).map((f) => f.id),
  persisting: all.filter((f) => prevIds.has(f.id)).map((f) => f.id),
  resolved: [...prevIds].filter((id) => !curIds.has(id)).map((id) => ({ id, title: previous.findings[id].title })),
};

const scores = lh?.pages[0]?.scores ?? null;
if (scores && previous?.scores) {
  for (const [k, v] of Object.entries(scores)) {
    const d = v - (previous.scores[k] ?? v);
    scoreDeltas[k] = { delta: d, significant: Math.abs(d) >= NOISE_POINTS };
  }
}

all.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || a.id.localeCompare(b.id));
const shown = all.slice(0, MAX_FINDINGS);
const counts = Object.fromEntries(SEV.map((s) => [s, all.filter((f) => f.severity === s).length]));

const findings = {
  site: config.site.name,
  url: config.site.url,
  date,
  checks_run: Object.fromEntries([["raw-vs-rendered", !!rvr], ["site-files", !!files], ["links-and-alt", !!links], ["lighthouse", !!lh], ["deps", !!deps && !deps.skipped]]),
  scores, score_changes: scoreDeltas, severity_counts: counts,
  omitted_lower_priority: all.length - shown.length,
  diff, findings: shown,
};
writeFileSync(opt("--out", "findings.json"), JSON.stringify(findings, null, 2));
writeFileSync(opt("--state", "state.json"), JSON.stringify({
  date, scores,
  findings: Object.fromEntries(all.map((f) => [f.id, { title: f.title, severity: f.severity, first_seen: f.first_seen }])),
}, null, 2));
console.error(`${all.length} findings (${shown.length} listed): ${JSON.stringify(counts)}; new ${diff.new.length}, resolved ${diff.resolved.length}`);
