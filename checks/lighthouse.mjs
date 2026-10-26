// Runs Lighthouse (mobile profile) several times per page and reports the median.
// Usage: node checks/lighthouse.mjs <siteUrl> [--sitemap /sitemap.xml] [--pages 1] [--runs 3]
// Scores under about 5 points of movement are noise on shared CI runners; the report
// carries the per-run spread so the condensing step can apply that threshold.
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { chromium } from "playwright";
import { clip, pageList, parseArgs } from "./lib.mjs";

const { base, sitemapPath, opt } = parseArgs(
  process.argv.slice(2),
  "lighthouse.mjs <siteUrl> [--sitemap /sitemap.xml] [--pages 1] [--runs 3]",
);
const pageCount = Number(opt("--pages", "1"));
const runs = Number(opt("--runs", "3"));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function runOnce(url) {
  const chrome = await chromeLauncher.launch({
    chromePath: process.env.CHROME_PATH || chromium.executablePath(),
    chromeFlags: ["--headless=new", "--no-sandbox"],
  });
  try {
    const res = await lighthouse(url, { port: chrome.port, output: "json", logLevel: "error" });
    return res.lhr;
  } finally {
    await chrome.kill();
  }
}

const urls = (await pageList(base, sitemapPath, pageCount)).slice(0, pageCount);
const pages = [];
for (const url of urls) {
  console.error(`Lighthouse x${runs}: ${url}`);
  const lhrs = [];
  for (let i = 0; i < runs; i++) lhrs.push(await runOnce(url));

  const cats = ["performance", "seo", "accessibility", "best-practices"];
  const scores = {};
  const spread = {};
  for (const c of cats) {
    const vals = lhrs.map((r) => Math.round((r.categories[c].score ?? 0) * 100));
    scores[c] = median(vals);
    spread[c] = Math.max(...vals) - Math.min(...vals);
  }
  const metricIds = ["first-contentful-paint", "largest-contentful-paint", "total-blocking-time", "cumulative-layout-shift", "speed-index"];
  const metrics = {};
  for (const m of metricIds) metrics[m] = median(lhrs.map((r) => r.audits[m].numericValue));

  // Failing audits from the run whose performance score is the median.
  const ranked = [...lhrs].sort((a, b) => a.categories.performance.score - b.categories.performance.score);
  const rep = ranked[Math.floor(ranked.length / 2)];
  const failing = [];
  for (const c of cats) {
    for (const ref of rep.categories[c].auditRefs) {
      const a = rep.audits[ref.id];
      if (a.score !== null && a.score < 0.9 && ref.weight > 0) {
        failing.push({ category: c, id: a.id, title: clip(a.title, 120), score: a.score, display: c === "performance" ? "" : clip(a.displayValue ?? "", 80) }); // perf values come from `metrics` (medians)
      }
    }
  }
  pages.push({ url, runs, scores, spread, metrics, failing_audits: failing });
}

console.log(JSON.stringify({ check: "lighthouse", site: base.origin, profile: "mobile", pages }, null, 2));
