/**
 * Read-only validation of the Player API tools against a real line.
 *
 * Usage:
 *   XUI_URL=... XUI_API_KEY=... LINE_USER=... LINE_PASS=... node scripts/validate-player.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const username = process.env.LINE_USER;
const password = process.env.LINE_PASS;
if (!username || !password) {
  console.error("Set LINE_USER and LINE_PASS.");
  process.exit(1);
}

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};
const text = (r) => r.content?.[0]?.text ?? "";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env },
});
const client = new Client({ name: "validate-player", version: "1.0.0" });
await client.connect(transport);

console.log("\n== player API ==");

const { tools } = await client.listTools();
check("player tools registered",
  tools.filter((t) => t.name.startsWith("xui_player_")).length === 3,
  tools.filter((t) => t.name.startsWith("xui_player_")).map((t) => t.name).join(", "));

const auth = await client.callTool({
  name: "xui_player_check_line",
  arguments: { username, password, response_format: "json" },
});
check("line authenticates", !auth.isError);
if (!auth.isError) {
  const a = JSON.parse(text(auth));
  check("auth flag true", a.authenticated === true, `status=${a.status}`);
  check("expiry parsed to ISO", typeof a.expires_at === "string" && a.expires_at.includes("T"), a.expires_at);
  check("connection limits reported", typeof a.max_connections === "number", `${a.active_connections}/${a.max_connections}`);
  check("output formats reported", Array.isArray(a.allowed_output_formats),
    a.allowed_output_formats.join(",") || "EMPTY — playback would fail");
  check("server info present", a.panel_version.length > 0, `panel ${a.panel_version}`);
}

const cats = await client.callTool({
  name: "xui_player_browse",
  arguments: { username, password, resource: "get_live_categories", response_format: "json" },
});
check("live categories readable", !cats.isError, `${JSON.parse(text(cats)).total} category(ies)`);

const streams = await client.callTool({
  name: "xui_player_browse",
  arguments: { username, password, resource: "get_live_streams", limit: 2, response_format: "json" },
});
const s = JSON.parse(text(streams));
check("live streams readable", !streams.isError, `${s.total} stream(s)`);
check("pagination applied", s.count <= 2 && typeof s.has_more === "boolean");

const empty = await client.callTool({
  name: "xui_player_browse",
  arguments: { username, password, resource: "get_vod_streams", response_format: "json" },
});
check("empty catalogue handled", !empty.isError && JSON.parse(text(empty)).total === 0);

if (s.total > 0) {
  const epg = await client.callTool({
    name: "xui_player_epg",
    arguments: { username, password, stream_id: String(s.items[0].stream_id), response_format: "json" },
  });
  check("epg readable", !epg.isError, `${JSON.parse(text(epg)).count} listing(s)`);
}

const bad = await client.callTool({
  name: "xui_player_check_line",
  arguments: { username, password: "definitely-wrong", response_format: "json" },
});
check("wrong password reports not authenticated",
  bad.isError === true || JSON.parse(text(bad)).authenticated === false);

await client.close();
console.log(failures === 0 ? "\nPlayer validation passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
