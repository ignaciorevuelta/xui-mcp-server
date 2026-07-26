/**
 * End-to-end smoke test: drives the built MCP server over stdio against the
 * local mock panel, exercising the read tools, the write gate and a full
 * create -> renew -> delete cycle.
 *
 * Usage:  npm run mock   (in another shell)
 *         node scripts/smoke.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MOCK = { XUI_URL: "http://127.0.0.1:8899/", XUI_API_KEY: "test-key" };

let failures = 0;

function check(label, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function connect(extraEnv) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, ...MOCK, ...extraEnv },
  });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const text = (r) => r.content?.[0]?.text ?? "";

console.log("\n== read-only mode (defaults) ==");
{
  const client = await connect({});
  const { tools } = await client.listTools();
  const reseller = tools.filter(
    (t) =>
      !t.name.startsWith("xui_admin_") &&
      !t.name.startsWith("xui_server_") &&
      !t.name.startsWith("xui_player_"),
  );
  check("reseller tools registered", reseller.length === 8, `${reseller.length} of ${tools.length}`);
  check("admin tools registered", tools.filter((t) => t.name.startsWith("xui_admin_")).length === 5);
  check("provisioning tools registered", tools.filter((t) => t.name.startsWith("xui_server_")).length === 4);
  check("player tools registered", tools.filter((t) => t.name.startsWith("xui_player_")).length === 3);

  const del = tools.find((t) => t.name === "xui_delete_line");
  check("delete_line marked destructive", del?.annotations?.destructiveHint === true);
  check("get_line marked read-only",
    tools.find((t) => t.name === "xui_get_line")?.annotations?.readOnlyHint === true);

  const info = await client.callTool({ name: "xui_user_info", arguments: { response_format: "json" } });
  const owner = JSON.parse(text(info));
  check("user_info returns key owner", owner.username === "owner", `credits=${owner.credits}`);

  const line = await client.callTool({
    name: "xui_get_line",
    arguments: { line_id: "1612073", response_format: "json" },
  });
  const parsed = JSON.parse(text(line));
  check("get_line active line", parsed.status === "active", `expires ${parsed.exp_date}`);
  check("get_line coerces string numerics", typeof parsed.package_id === "number" && parsed.package_id === 134);

  const expired = await client.callTool({
    name: "xui_get_line",
    arguments: { line_id: "1735171", response_format: "json" },
  });
  check("expired line detected", JSON.parse(text(expired)).status === "expired");

  const blocked = await client.callTool({
    name: "xui_create_line",
    arguments: { package_id: 134, response_format: "json" },
  });
  check("write blocked when XUI_ALLOW_WRITES=false", blocked.isError === true);
  check("block message is actionable", text(blocked).includes("XUI_ALLOW_WRITES"));

  const missing = await client.callTool({
    name: "xui_get_line",
    arguments: { line_id: "999999", response_format: "json" },
  });
  check("unknown line surfaces panel error", missing.isError === true, text(missing).slice(0, 60));

  await client.close();
}

console.log("\n== writes enabled, delete still gated ==");
{
  const client = await connect({ XUI_ALLOW_WRITES: "true" });

  const created = await client.callTool({
    name: "xui_create_line",
    arguments: { package_id: 134, response_format: "json" },
  });
  const line = JSON.parse(text(created));
  check("create_line succeeds", !created.isError && /^\d+$/.test(line.id), `id=${line.id}`);
  check("credentials generated", line.username.length >= 10 && line.password.length >= 12);

  const renewed = await client.callTool({
    name: "xui_renew_line",
    arguments: { line_id: line.id, package_id: 134, response_format: "json" },
  });
  const after = JSON.parse(text(renewed));
  check("renew extends expiry", after.exp_date_unix > line.exp_date_unix);

  const trial = await client.callTool({
    name: "xui_create_trial",
    arguments: { package_id: 82, response_format: "json" },
  });
  const t = JSON.parse(text(trial));
  const hours = (t.exp_date_unix - Math.floor(Date.now() / 1000)) / 3600;
  check("trial honours package duration", hours > 4.9 && hours < 5.1, `${hours.toFixed(2)}h`);

  // Compare against the balance read back rather than a fixed number, so a mock
  // left running from an earlier run does not fail the check.
  const before = JSON.parse(
    text(await client.callTool({
      name: "xui_get_user",
      arguments: { user_id: "4821", response_format: "json" },
    })),
  ).credits;
  const credits = await client.callTool({
    name: "xui_add_reseller_credits",
    arguments: { reseller_id: "4821", credits: 100, response_format: "json" },
  });
  check("credits topped up", JSON.parse(text(credits)).new_balance === before + 100,
    `${before} -> ${JSON.parse(text(credits)).new_balance}`);

  const del = await client.callTool({
    name: "xui_delete_line",
    arguments: { line_id: line.id, response_format: "json" },
  });
  check("delete still blocked without XUI_ALLOW_DELETE", del.isError === true);
  check("delete block mentions its own flag", text(del).includes("XUI_ALLOW_DELETE"));

  await client.close();
}

console.log("\n== delete enabled ==");
{
  const client = await connect({ XUI_ALLOW_WRITES: "true", XUI_ALLOW_DELETE: "true" });
  const created = JSON.parse(
    text(await client.callTool({ name: "xui_create_line", arguments: { package_id: 114, response_format: "json" } })),
  );
  const del = await client.callTool({
    name: "xui_delete_line",
    arguments: { line_id: created.id, response_format: "json" },
  });
  check("delete succeeds when enabled", !del.isError && JSON.parse(text(del)).deleted === true);

  const gone = await client.callTool({
    name: "xui_get_line",
    arguments: { line_id: created.id, response_format: "json" },
  });
  check("deleted line is gone", gone.isError === true);
  await client.close();
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
