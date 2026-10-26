// Checks robots.txt, sitemap.xml and security headers.
// Usage: node checks/site-files.mjs <siteUrl> [--sitemap /sitemap.xml] [--max-pages 25]
// Output: JSON on stdout.
import * as cheerio from "cheerio";
import { clip, parseArgs } from "./lib.mjs";

const { base, sitemapPath, maxPages } = parseArgs(
  process.argv.slice(2),
  "site-files.mjs <siteUrl> [--sitemap /sitemap.xml] [--max-pages 25]",
);
const findings = [];
const add = (check, detail) => findings.push({ check, ...detail });

// --- robots.txt ---
const robotsRes = await fetch(new URL("/robots.txt", base));
if (!robotsRes.ok) {
  add("robots_missing", { url: "/robots.txt", status: robotsRes.status });
} else {
  const text = await robotsRes.text();
  if (!/^sitemap:\s*\S+/im.test(text)) add("robots_no_sitemap_line", { url: "/robots.txt" });
  // Disallow: / under a "User-agent: *" group blocks the whole site.
  const groups = text.split(/\n\s*\n/);
  for (const g of groups) {
    if (/^user-agent:\s*\*/im.test(g) && /^disallow:\s*\/\s*$/im.test(g)) add("robots_blocks_all", { url: "/robots.txt" });
  }
}

// --- sitemap.xml ---
const smRes = await fetch(new URL(sitemapPath, base));
if (!smRes.ok) {
  add("sitemap_missing", { url: sitemapPath, status: smRes.status });
} else {
  const $ = cheerio.load(await smRes.text(), { xmlMode: true });
  const locs = $("url > loc").map((_, el) => $(el).text().trim()).get();
  if (locs.length === 0) add("sitemap_empty", { url: sitemapPath });
  const relative = locs.filter((l) => !/^https?:\/\//.test(l));
  if (relative.length) add("sitemap_relative_urls", { url: sitemapPath, count: relative.length, examples: relative.slice(0, 3).map((l) => clip(l)) });
  const offHost = locs.filter((l) => /^https?:\/\//.test(l) && new URL(l).host !== base.host);
  if (offHost.length) add("sitemap_other_host", { url: sitemapPath, examples: offHost.slice(0, 3).map((l) => clip(l)) });
  for (const loc of locs.slice(0, maxPages)) {
    const u = new URL(loc, base);
    const r = await fetch(u, { method: "HEAD", redirect: "manual" });
    if (r.status !== 200) add("sitemap_url_not_200", { url: u.href, status: r.status });
  }
}

// --- security headers (homepage) ---
const home = await fetch(base, { redirect: "follow" });
const h = (n) => home.headers.get(n);
const hsts = h("strict-transport-security");
const maxAge = Number(/max-age=(\d+)/i.exec(hsts ?? "")?.[1] ?? 0);
if (!hsts) add("header_missing", { header: "Strict-Transport-Security" });
else if (maxAge < 15768000) add("hsts_short", { actual: clip(hsts), expected: "max-age>=15768000" });
if (!h("content-security-policy")) add("header_missing", { header: "Content-Security-Policy" });
if (!h("x-frame-options") && !/frame-ancestors/i.test(h("content-security-policy") ?? ""))
  add("header_missing", { header: "X-Frame-Options (or CSP frame-ancestors)" });
if (!/nosniff/i.test(h("x-content-type-options") ?? "")) add("header_missing", { header: "X-Content-Type-Options" });
if (!h("referrer-policy")) add("header_missing", { header: "Referrer-Policy" });
if (!h("permissions-policy")) add("header_missing", { header: "Permissions-Policy" });

// --- http -> https redirect ---
const http = new URL(base);
http.protocol = "http:";
try {
  const r = await fetch(http, { redirect: "manual" });
  const loc = r.headers.get("location") ?? "";
  if (!(r.status >= 301 && r.status <= 308 && loc.startsWith("https://"))) add("no_https_redirect", { status: r.status, location: clip(loc) });
} catch (e) {
  add("http_unreachable", { error: clip(e.message) });
}

console.log(JSON.stringify({ check: "site-files", site: base.origin, findings }, null, 2));
