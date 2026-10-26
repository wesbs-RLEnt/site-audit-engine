// Crawls sitemap pages (raw HTML, as a crawler sees them) and checks internal links,
// image alt text and image size.
// Usage: node checks/links-and-alt.mjs <siteUrl> [--sitemap /sitemap.xml] [--max-pages 25] [--max-links 100]
// External links are not checked in the MVP.
import * as cheerio from "cheerio";
import { clip, pageList, parseArgs } from "./lib.mjs";

const argv = process.argv.slice(2);
const { base, sitemapPath, maxPages, opt } = parseArgs(
  argv,
  "links-and-alt.mjs <siteUrl> [--sitemap /sitemap.xml] [--max-pages 25] [--max-links 100]",
);
const maxLinks = Number(opt("--max-links", "100"));
const MAX_IMAGE_BYTES = 400 * 1024;

const findings = [];
const add = (check, detail) => findings.push({ check, ...detail });

async function probe(url) {
  let r = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (r.status === 405 || r.status === 501) r = await fetch(url, { redirect: "follow" });
  return r;
}

const pages = await pageList(base, sitemapPath, maxPages);
const links = new Map(); // url -> pages it appears on
const images = new Map();
let pagesFetched = 0;

for (const pageUrl of pages) {
  const res = await fetch(pageUrl);
  if (!res.ok) {
    add("page_not_200", { url: pageUrl, status: res.status });
    continue;
  }
  pagesFetched++;
  const $ = cheerio.load(await res.text());
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href").trim();
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    const u = new URL(href, pageUrl);
    if (u.host !== base.host) return;
    u.hash = "";
    links.set(u.href, [...(links.get(u.href) ?? []), pageUrl]);
  });
  $("img").each((_, el) => {
    const src = $(el).attr("src");
    if ($(el).attr("alt") === undefined) add("img_missing_alt", { page: pageUrl, src: clip(src, 200) });
    if (src && !src.startsWith("data:")) {
      const u = new URL(src, pageUrl).href;
      images.set(u, [...(images.get(u) ?? []), pageUrl]);
    }
  });
}

for (const [url, from] of [...links].slice(0, maxLinks)) {
  try {
    const r = await probe(url);
    if (r.status >= 400) add("broken_internal_link", { url, status: r.status, found_on: [...new Set(from)].slice(0, 3) });
  } catch (e) {
    add("broken_internal_link", { url, error: clip(e.message), found_on: [...new Set(from)].slice(0, 3) });
  }
}

for (const [url, from] of images) {
  try {
    const r = await probe(url);
    const bytes = Number(r.headers.get("content-length") ?? 0);
    if (r.status >= 400) add("broken_image", { url, status: r.status, found_on: [...new Set(from)].slice(0, 3) });
    else if (bytes > MAX_IMAGE_BYTES) add("oversized_image", { url, bytes, limit: MAX_IMAGE_BYTES, found_on: [...new Set(from)].slice(0, 3) });
  } catch (e) {
    add("broken_image", { url, error: clip(e.message) });
  }
}

console.log(JSON.stringify({
  check: "links-and-alt",
  site: base.origin,
  pages_checked: pagesFetched,
  internal_links_checked: Math.min(links.size, maxLinks),
  images_seen: images.size,
  findings,
}, null, 2));
