// Calls the Anthropic Messages API once, with NO tools, to write the report.
// A plain API call (not an agent loop) means the model cannot run commands, read files
// or reach the network, whatever the page content tries to tell it.
// Usage: node scripts/generate-report.mjs <prompt.md> <config.yml> <findings.json> [previous-ledger.md] > report.md
// Env: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL, USAGE_FILE (write token counts there),
//      ANTHROPIC_BASE_URL (tests only)
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [promptPath, configPath, findingsPath, ledgerPath] = process.argv.slice(2);
if (!findingsPath) {
  console.error("Usage: generate-report.mjs <prompt.md> <config.yml> <findings.json> [previous-ledger.md]");
  process.exit(2);
}
const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error("ANTHROPIC_API_KEY is not set");
  process.exit(1);
}
const MAX_INPUT_CHARS = 60000; // input cap: bounds cost and the prompt-injection surface
const ledger = ledgerPath && existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").slice(-8000) : "(none: first run)";
const input = [
  "<config>", readFileSync(configPath, "utf8"), "</config>",
  "<previous_ledger>", ledger, "</previous_ledger>",
  "<findings_json>", readFileSync(findingsPath, "utf8"), "</findings_json>",
].join("\n");
if (input.length > MAX_INPUT_CHARS) {
  console.error(`Input is ${input.length} chars, over the ${MAX_INPUT_CHARS} cap`);
  process.exit(1);
}

const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
    max_tokens: 3000,
    system: readFileSync(promptPath, "utf8"),
    messages: [{ role: "user", content: input }],
  }),
  signal: AbortSignal.timeout(180000),
});
if (!res.ok) {
  console.error(`API returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const data = await res.json();
const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
if (!text.trim()) {
  console.error("Empty response");
  process.exit(1);
}
const usage = { model: data.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 };
console.error(`tokens: in ${usage.input_tokens}, out ${usage.output_tokens}`);
if (process.env.USAGE_FILE) writeFileSync(process.env.USAGE_FILE, JSON.stringify(usage));
process.stdout.write(text.trim() + "\n");
