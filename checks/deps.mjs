// Dependency audit without needing the site's package manager installed.
// Reads the lockfile (bun.lock or package-lock.json), asks the public npm registry for
// advisories (bulk endpoint) and latest versions. Only package names and versions are sent.
// Usage: node checks/deps.mjs <path-to-site-repo>
// Output: JSON on stdout. Unsupported lockfiles produce a "skipped" result, not an error.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: deps.mjs <path-to-site-repo>");
  process.exit(2);
}
const out = (o) => console.log(JSON.stringify({ check: "deps", ...o }, null, 2));
const clip = (s, n = 300) => String(s ?? "").slice(0, n);

const pkgPath = join(dir, "package.json");
if (!existsSync(pkgPath)) {
  out({ skipped: "no package.json" });
  process.exit(0);
}
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const direct = { ...pkg.dependencies, ...pkg.devDependencies };

// name -> Set(versions) for everything installed
const installed = new Map();
const addVersion = (name, version) => {
  if (!installed.has(name)) installed.set(name, new Set());
  installed.get(name).add(version);
};
// name -> Set(dependency names), used to find what is reachable from runtime dependencies
const edges = new Map();
const addEdges = (name, ...maps) => {
  if (!edges.has(name)) edges.set(name, new Set());
  for (const m of maps) for (const d of Object.keys(m ?? {})) edges.get(name).add(d);
};

let lockfile;
if (existsSync(join(dir, "bun.lock"))) {
  lockfile = "bun.lock";
  // bun.lock is JSONC: strip trailing commas, then parse.
  const text = readFileSync(join(dir, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1");
  for (const entry of Object.values(JSON.parse(text).packages ?? {})) {
    const id = entry[0]; // "name@version"
    const at = id.lastIndexOf("@");
    if (at > 0) {
      addVersion(id.slice(0, at), id.slice(at + 1));
      addEdges(id.slice(0, at), entry[2]?.dependencies, entry[2]?.optionalDependencies);
    }
  }
} else if (existsSync(join(dir, "package-lock.json"))) {
  lockfile = "package-lock.json";
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    if (!path || !info.version) continue;
    const n = path.split("node_modules/").pop();
    addVersion(n, info.version);
    addEdges(n, info.dependencies, info.optionalDependencies);
  }
} else {
  out({ skipped: "no supported lockfile (bun.lock or package-lock.json)" });
  process.exit(0);
}

// --- runtime reachability: everything reachable from package.json "dependencies" ---
// Name-level approximation of the lockfile graph. Conservative: a package that any runtime
// dependency pulls in counts as runtime, even if it is only used at build time there.
const runtime = new Set();
const queue = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
while (queue.length) {
  const n = queue.pop();
  if (runtime.has(n)) continue;
  runtime.add(n);
  for (const d of edges.get(n) ?? []) queue.push(d);
}

// --- vulnerabilities ---
const body = Object.fromEntries([...installed].map(([n, v]) => [n, [...v]]));
const advRes = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
if (!advRes.ok) throw new Error(`advisory API returned ${advRes.status}`);
const adv = await advRes.json();
const vulnerabilities = [];
for (const [name, list] of Object.entries(adv)) {
  for (const a of list) {
    vulnerabilities.push({
      package: name,
      direct: name in direct,
      runtime: runtime.has(name),
      installed: [...installed.get(name)],
      severity: a.severity,
      title: clip(a.title, 200),
      vulnerable_versions: clip(a.vulnerable_versions, 100),
      url: a.url,
    });
  }
}

// Latest published version for each vulnerable package, so fixes can name a target.
const latestOf = async (name) => {
  const r = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`);
  return r.ok ? (await r.json()).version : null;
};
const vulnLatest = {};
for (const name of new Set(vulnerabilities.map((v) => v.package))) vulnLatest[name] = await latestOf(name);
for (const v of vulnerabilities) v.latest = vulnLatest[v.package];

// --- outdated (direct dependencies only) ---
const parse = (v) => v.split("-")[0].split(".").map(Number);
const outdated = [];
for (const name of Object.keys(direct)) {
  const cur = [...(installed.get(name) ?? [])].sort().pop();
  if (!cur) continue;
  const r = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`);
  if (!r.ok) continue;
  const latest = (await r.json()).version;
  const [c, l] = [parse(cur), parse(latest)];
  const kind = l[0] > c[0] ? "major" : l[1] > c[1] ? "minor" : l[2] > c[2] ? "patch" : null;
  if (kind) outdated.push({ package: name, installed: cur, latest, update: kind });
}

out({ lockfile, packages: installed.size, direct_dependencies: Object.keys(direct).length, vulnerabilities, outdated });
