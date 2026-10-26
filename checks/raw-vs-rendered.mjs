// Compares what crawlers get (raw HTML) with what a browser ends up with (rendered DOM).
// Usage: node checks/raw-vs-rendered.mjs <siteUrl> [--sitemap /sitemap.xml] [--max-pages 25]
// Output: JSON on stdout. Logs go to stderr.
import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { clip, pageList, parseArgs } from "./lib.mjs";

const { base, sitemapPath, maxPages } = parseArgs(
  process.argv.slice(2),
  "raw-vs-rendered.mjs <siteUrl> [--sitemap /sitemap.xml] [--max-pages 25]",
);

// URL-valued fields in JSON-LD (url, image, logo), plus a count of blocks that fail to parse.
function jsonld($) {
  const urls = [];
  let blocks = 0, invalid = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (["url", "image", "logo"].includes(k)) {
        for (const x of Array.isArray(v) ? v : [v]) {
          const val = typeof x === "string" ? x : x?.url;
          if (typeof val === "string") urls.push({ field: k, value: clip(val, 200) });
        }
      }
      walk(v);
    }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    blocks++;
    try {
      walk(JSON.parse($(el).text()));
    } catch {
      invalid++;
    }
  });
  return { jsonld_blocks: blocks, jsonld_invalid: invalid, jsonld_urls: urls.slice(0, 20) };
}

function extract($) {
  const meta = (sel) => clip($(sel).attr("content"));
  return {
    title: clip($("title").first().text()) || null,
    description: meta('meta[name="description"]'),
    canonical: clip($('link[rel="canonical"]').attr("href")),
    og_title: meta('meta[property="og:title"]'),
    og_description: meta('meta[property="og:description"]'),
    og_image: meta('meta[property="og:image"]'),
    og_url: meta('meta[property="og:url"]'),
    ...jsonld($),
    h1_count: $("h1").length,
    body_text_length: $("body").text().replace(/\s+/g, " ").trim().length,
  };
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
  if (raw.og_url && !/^https?:\/\//.test(raw.og_url)) out.push({ type: "relative_url", field: "og:url" });
  if (raw.jsonld_blocks === 0) out.push({ type: "missing", field: "structured data" });
  if (raw.jsonld_invalid > 0) out.push({ type: "jsonld_invalid", field: "structured data", count: raw.jsonld_invalid });
  const rel = raw.jsonld_urls.filter((u) => !/^https?:\/\//.test(u.value));
  if (rel.length) out.push({ type: "jsonld_relative_url", field: "structured data", examples: rel.slice(0, 3) });
  const sameSite = (h) => h.replace(/^www\./, "") === base.host.replace(/^www\./, "");
  const other = raw.jsonld_urls.filter((u) => /^https?:\/\//.test(u.value) && !sameSite(new URL(u.value).host));
  if (other.length) out.push({ type: "jsonld_other_host", field: "structured data", examples: other.slice(0, 3) });
  if (raw.h1_count !== 1) out.push({ type: "h1_count", expected: 1, actual: raw.h1_count });
  if (rendered.body_text_length > 0 && raw.body_text_length < rendered.body_text_length * 0.5)
    out.push({ type: "thin_raw_html", raw: raw.body_text_length, rendered: rendered.body_text_length });
  return out;
}

const urls = await pageList(base, sitemapPath, maxPages);
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
