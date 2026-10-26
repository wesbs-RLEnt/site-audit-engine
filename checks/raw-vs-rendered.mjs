// Compares what crawlers get (raw HTML) with what a browser ends up with (rendered DOM).
// Usage: node checks/raw-vs-rendered.mjs <siteUrl> [--sitemap /sitemap.xml] [--max-pages 25]
// Output: JSON on stdout. Logs go to stderr.
import * as cheerio from "cheerio";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const siteUrl = args[0];
if (!siteUrl) {
  console.error("Usage: raw-vs-rendered.mjs <siteUrl> [--sitemap /sitemap.xml] [--max-pages 25]");
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const sitemapPath = opt("--sitemap", "/sitemap.xml");
const maxPages = Number(opt("--max-pages", "25"));
const base = new URL(siteUrl);

// Page content is untrusted: cap length so it can't flood the findings JSON.
const clip = (s, n = 300) => (s == null ? null : String(s).trim().slice(0, n));

function extract($) {
  const meta = (sel) => clip($(sel).attr("content"));
  return {
    title: clip($("title").first().text()) || null,
    description: meta('meta[name="description"]'),
    canonical: clip($('link[rel="canonical"]').attr("href")),
    og_title: meta('meta[property="og:title"]'),
    og_description: meta('meta[property="og:description"]'),
    og_image: meta('meta[property="og:image"]'),
    h1_count: $("h1").length,
    body_text_length: $("body").text().replace(/\s+/g, " ").trim().length,
  };
}

async function pageList() {
  const res = await fetch(new URL(sitemapPath, base));
  if (!res.ok) throw new Error(`sitemap ${sitemapPath} returned ${res.status}`);
  const $ = cheerio.load(await res.text(), { xmlMode: true });
  const urls = $("url > loc")
    .map((_, el) => new URL($(el).text().trim(), base).href) // tolerate relative <loc>
    .get();
  return [...new Set(urls)].slice(0, maxPages);
}

function flags(url, raw, rendered) {
  const out = [];
  const field = (name, f) => {
    if (!raw[f] && rendered[f]) out.push({ type: "missing_in_raw_html", field: name });
    else if (!raw[f]) out.push({ type: "missing", field: name });
  };
  field("title", "title");
  field("meta description", "description");
  field("canonical", "canonical");
  field("og:title", "og_title");
  field("og:description", "og_description");
  field("og:image", "og_image");
  if (raw.canonical && !/^https?:\/\//.test(raw.canonical)) out.push({ type: "relative_url", field: "canonical" });
  if (raw.h1_count !== 1) out.push({ type: "h1_count", expected: 1, actual: raw.h1_count });
  if (rendered.body_text_length > 0 && raw.body_text_length < rendered.body_text_length * 0.5)
    out.push({ type: "thin_raw_html", raw: raw.body_text_length, rendered: rendered.body_text_length });
  return out;
}

const urls = await pageList();
console.error(`Checking ${urls.length} pages`);
const browser = await chromium.launch();
const results = [];
const titles = new Map();
try {
  for (const url of urls) {
    const entry = { url };
    try {
      const rawRes = await fetch(url, { redirect: "follow" });
      entry.status = rawRes.status;
      const raw = extract(cheerio.load(await rawRes.text()));
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      const rendered = extract(cheerio.load(await page.content()));
      await page.close();
      Object.assign(entry, { raw, rendered, flags: flags(url, raw, rendered) });
      if (raw.title) titles.set(raw.title, [...(titles.get(raw.title) ?? []), url]);
    } catch (e) {
      entry.error = clip(e.message);
    }
    results.push(entry);
  }
} finally {
  await browser.close();
}

const duplicate_titles = [...titles].filter(([, u]) => u.length > 1).map(([title, pages]) => ({ title, pages }));
console.log(JSON.stringify({ check: "raw-vs-rendered", site: base.origin, pages_checked: results.length, duplicate_titles, results }, null, 2));
