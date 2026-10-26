// Shared helpers for check scripts.
import * as cheerio from "cheerio";

export function parseArgs(argv, usage) {
  const siteUrl = argv[0];
  if (!siteUrl || siteUrl.startsWith("--")) {
    console.error(`Usage: ${usage}`);
    process.exit(2);
  }
  const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  return {
    opt,
    base: new URL(siteUrl),
    sitemapPath: opt("--sitemap", "/sitemap.xml"),
    maxPages: Number(opt("--max-pages", "25")),
  };
}

// Page content is untrusted: cap length so it can't flood the findings JSON.
export const clip = (s, n = 300) => (s == null ? null : String(s).trim().slice(0, n));

// Page URLs from the sitemap. Tolerates relative <loc> values.
export async function pageList(base, sitemapPath, maxPages) {
  const res = await fetch(new URL(sitemapPath, base));
  if (!res.ok) throw new Error(`sitemap ${sitemapPath} returned ${res.status}`);
  const $ = cheerio.load(await res.text(), { xmlMode: true });
  const urls = $("url > loc")
    .map((_, el) => new URL($(el).text().trim(), base).href)
    .get();
  return [...new Set(urls)].slice(0, maxPages);
}
