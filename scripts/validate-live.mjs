/**
 * Read-only validation of the MCP server against a real XUI panel.
 *
 * Unlike scripts/smoke.mjs (which drives the local mock through a full
 * create/renew/delete cycle), this only exercises tools that cannot change
 * anything, so it is safe to point at a live panel. Writes stay disabled.
 *
 * Usage:
 *   XUI_URL=https://host/<reseller-api-code>/ XUI_API_KEY=... node scripts/validate-live.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { XUI_URL, XUI_API_KEY } = process.env;
if (!XUI_URL || !XUI_API_KEY) {
  console.error("Set XUI_URL and XUI_API_KEY.");
  process.exit(1);
}

// The parent environment must not decide what these tests exercise: inheriting a
// XUI_ALLOW_WRITES=true from the shell would silently turn gate assertions into
// live calls. Start every child from a known-closed state.
const CLOSED_GATES = {
  XUI_ALLOW_WRITES: "false",
  XUI_ALLOW_DELETE: "false",
  XUI_ALLOW_PROVISIONING: "false",
};

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};
const text = (r) => r.content?.[0]?.text ?? "";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  // Writes deliberately left at their default (disabled).
  env: { ...process.env, ...CLOSED_GATES, XUI_URL, XUI_API_KEY },
});
const client = new Client({ name: "validate-live", version: "1.0.0" });
await client.connect(transport);

console.log(`\n== live panel: ${XUI_URL} ==`);

const info = await client.callTool({
  name: "xui_user_info",
  arguments: { response_format: "json" },
});
check("user_info reaches the panel", !info.isError, text(info).slice(0, 80));

if (!info.isError) {
  const owner = JSON.parse(text(info));
  check("returns the key owner", typeof owner.username === "string" && owner.username.length > 0,
    `${owner.username} (id ${owner.id})`);
  check("credits coerced to a number", typeof owner.credits === "number",
    `credits=${owner.credits}`);
  check("id kept as a string (panel ids exceed 2^53)", typeof owner.id === "string");
}

// A line id that will not exist: confirms the panel's error text is surfaced
// rather than swallowed or mistaken for success.
const missing = await client.callTool({
  name: "xui_get_line",
  arguments: { line_id: "999999999", response_format: "json" },
});
check("unknown line surfaces the panel error", missing.isError === true, text(missing).slice(0, 70));

// The write gate must hold even against a live panel.
const blocked = await client.callTool({
  name: "xui_create_line",
  arguments: { package_id: 1, response_format: "json" },
});
check("writes stay disabled by default", blocked.isError === true);

await client.close();
console.log(failures === 0 ? "\nLive validation passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
