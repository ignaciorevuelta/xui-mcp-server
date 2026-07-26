/**
 * Validation for the provisioning tools against a real host.
 *
 * Only preflight and status run by default — both are read-only. Pass
 * RUN_REPAIR=1 to also exercise the repair path, which is idempotent but does
 * restart the panel.
 *
 * Usage:
 *   PROV_HOST=1.2.3.4 PROV_KEY=/path/to/key node scripts/validate-provision.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const HOST = process.env.PROV_HOST;
const KEY = process.env.PROV_KEY;
if (!HOST || !KEY) {
  console.error("Set PROV_HOST and PROV_KEY.");
  process.exit(1);
}

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
  const client = new Client({ name: "validate-provision", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const target = { host: HOST, private_key_path: KEY, response_format: "json" };

console.log("\n== gates ==");
{
  const client = await connect({ XUI_ALLOW_PROVISIONING: "false" });
  const { tools } = await client.listTools();
  const prov = tools.filter((t) => t.name.startsWith("xui_server_"));
  check("provisioning tools registered", prov.length === 4, prov.map((t) => t.name).join(", "));

  const blocked = await client.callTool({ name: "xui_server_preflight", arguments: target });
  check("blocked when provisioning disabled", blocked.isError === true);
  check("names the flag to set", text(blocked).includes("XUI_ALLOW_PROVISIONING"));
  await client.close();
}
{
  const client = await connect({
    XUI_ALLOW_PROVISIONING: "true",
    XUI_PROVISION_HOSTS: "10.0.0.1,10.0.0.2",
  });
  const blocked = await client.callTool({ name: "xui_server_preflight", arguments: target });
  check("host allowlist enforced", blocked.isError === true && text(blocked).includes("XUI_PROVISION_HOSTS"));
  await client.close();
}
{
  const client = await connect({ XUI_ALLOW_PROVISIONING: "true" });
  const noCreds = await client.callTool({
    name: "xui_server_preflight",
    arguments: { host: HOST, response_format: "json" },
  });
  check("refuses without credentials", noCreds.isError === true);

  // Deliberately a client with writes OFF: this asserts the gate, and must never
  // be able to start a real install against the target host.
  const install = await client.callTool({
    name: "xui_server_install",
    arguments: { ...target, harden_ssh: false },
  });
  check("install respects the write gate", install.isError === true &&
    text(install).includes("XUI_ALLOW_WRITES"));
  await client.close();
}
{
  // With writes on, the preflight guard is what must stop it — the target already
  // has a panel, so installing over it would be destructive.
  const client = await connect({
    XUI_ALLOW_PROVISIONING: "true",
    XUI_PROVISION_HOSTS: HOST,
    XUI_ALLOW_WRITES: "true",
  });
  const install = await client.callTool({
    name: "xui_server_install",
    arguments: { ...target, harden_ssh: false },
  });
  check("install refuses when a panel already exists", install.isError === true &&
    text(install).includes("/home/xui"), text(install).slice(7, 80).replace(/\n/g, " "));
  await client.close();
}

console.log("\n== against the live host ==");
{
  // Writes are on so the repair path can run. Safe: the install tool's preflight
  // guard refuses a box that already has a panel, and repair is idempotent.
  const client = await connect({
    XUI_ALLOW_PROVISIONING: "true",
    XUI_PROVISION_HOSTS: HOST,
    XUI_ALLOW_WRITES: "true",
  });

  const pre = await client.callTool({ name: "xui_server_preflight", arguments: target });
  check("preflight reachable", !pre.isError, text(pre).slice(0, 60).replace(/\n/g, " "));
  if (!pre.isError) {
    const p = JSON.parse(text(pre));
    check("detects architecture and OS", p.arch === "x86_64" && !!p.os, `${p.os} ${p.arch}`);
    check("reports existing panel as a blocker", p.already_installed === true &&
      p.blockers.some((b) => b.includes("/home/xui")));
    check("reports resources", p.cpu_cores > 0 && p.memory_mb > 0,
      `${p.cpu_cores} cores, ${p.memory_mb} MB`);
  }

  const st = await client.callTool({ name: "xui_server_status", arguments: target });
  check("status reachable", !st.isError);
  if (!st.isError) {
    const s = JSON.parse(text(st));
    check("service reported active", s.service === "active", s.service);
    check("licence reported valid", /expires/i.test(s.licence), s.licence);
    check("no restart loop", s.restarts_last_three_min <= 1, `${s.restarts_last_three_min} in 3 min`);
    check("cache populated", s.cache_lines > 0, `${s.cache_lines} line(s)`);
    check("healthy", s.healthy === true, s.issues.join("; ") || "no issues");
  }

  if (process.env.RUN_REPAIR === "1") {
    // callTool takes (params, resultSchema, options). The schema must be passed
    // explicitly — leaving it undefined skips the default and the timeout option
    // with it, leaving the request on the SDK's 60-second default.
    const rep = await client.callTool(
      { name: "xui_server_repair", arguments: target },
      CallToolResultSchema,
      { timeout: 600_000 },
    );
    check("repair completes", !rep.isError && JSON.parse(text(rep)).all_ok === true);
    if (!rep.isError) {
      const steps = JSON.parse(text(rep)).steps;
      check("licence step is idempotent", steps.some((s) => s.label.includes("licence") && /already patched/.test(s.detail)));
    }
  }

  await client.close();
}

console.log(failures === 0 ? "\nProvisioning validation passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
