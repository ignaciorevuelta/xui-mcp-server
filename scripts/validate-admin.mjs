/**
 * Read-only validation of the Admin API tools against a real panel.
 *
 * Exercises listing, log feeds, the escape hatch and the write gates. Nothing
 * here mutates the panel, so it is safe to point at a live install.
 *
 * Usage:
 *   XUI_URL=... XUI_API_KEY=... XUI_ADMIN_URL=... XUI_ADMIN_API_KEY=... \
 *     node scripts/validate-admin.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};
const text = (r) => r.content?.[0]?.text ?? "";

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, ...extraEnv },
  });
  const client = new Client({ name: "validate-admin", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

console.log("\n== admin tools, read-only ==");
{
  const client = await connect();
  const { tools } = await client.listTools();
  const admin = tools.filter((t) => t.name.startsWith("xui_admin_"));
  check("admin tools registered", admin.length === 5, admin.map((t) => t.name).join(", "));
  check("total tool count", tools.length === 17, `${tools.length} tools`);

  const users = await client.callTool({
    name: "xui_admin_list",
    arguments: { resource: "get_users", response_format: "json" },
  });
  check("list users", !users.isError, text(users).slice(0, 60).replace(/\n/g, " "));
  if (!users.isError) {
    const o = JSON.parse(text(users));
    check("returns rows with panel field names", Array.isArray(o.items) && o.items.length > 0,
      `${o.total} user(s)`);
    check("pagination metadata present", typeof o.has_more === "boolean" && o.offset === 0);
  }

  const lines = await client.callTool({
    name: "xui_admin_list",
    arguments: { resource: "get_lines", limit: 1, offset: 0, response_format: "json" },
  });
  const lo = JSON.parse(text(lines));
  check("limit is honoured client-side", lo.count <= 1, `count=${lo.count} of ${lo.total}`);

  // get_bouquets answers with a bare array rather than the usual envelope.
  const bouquets = await client.callTool({
    name: "xui_admin_list",
    arguments: { resource: "get_bouquets", response_format: "json" },
  });
  check("bare-array responses normalised", !bouquets.isError && Array.isArray(JSON.parse(text(bouquets)).items));

  const conns = await client.callTool({
    name: "xui_admin_logs",
    arguments: { feed: "live_connections", response_format: "json" },
  });
  check("log feed reachable", !conns.isError, `live_connections total=${JSON.parse(text(conns)).total}`);

  const call = await client.callTool({
    name: "xui_admin_call",
    arguments: { action: "user_info", params: {}, response_format: "json" },
  });
  check("escape hatch works on a read action", !call.isError);

  // Prefixed get_ so the write gate lets it through and the panel is the one that refuses.
  const badAction = await client.callTool({
    name: "xui_admin_call",
    arguments: { action: "get_not_a_real_action", params: {}, response_format: "json" },
  });
  check("unknown action surfaces the panel's own error", badAction.isError === true &&
    text(badAction).includes("Invalid action"), text(badAction).slice(7, 75));

  const blockedWrite = await client.callTool({
    name: "xui_admin_set_line_state",
    arguments: { line_id: "2", state: "disable_line", response_format: "json" },
  });
  check("state change blocked without XUI_ALLOW_WRITES", blockedWrite.isError === true);

  const blockedCall = await client.callTool({
    name: "xui_admin_call",
    arguments: { action: "create_bouquet", params: { bouquet_name: "x" }, response_format: "json" },
  });
  check("escape hatch respects the write gate", blockedCall.isError === true);

  await client.close();
}

console.log("\n== admin credentials absent ==");
{
  const client = await connect({ XUI_ADMIN_URL: "", XUI_ADMIN_API_KEY: "" });
  const r = await client.callTool({
    name: "xui_admin_list",
    arguments: { resource: "get_users", response_format: "json" },
  });
  check("explains what to configure", r.isError === true && text(r).includes("XUI_ADMIN_URL"));
  await client.close();
}

console.log(failures === 0 ? "\nAdmin validation passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
