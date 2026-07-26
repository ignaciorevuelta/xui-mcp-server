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
  env: { ...process.env, ...CLOSED_GATES },
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

/** Parses only when the call succeeded, so an API error is reported rather than thrown. */
function parsed(result) {
  if (result.isError) return null;
  try {
    return JSON.parse(text(result));
  } catch {
    return null;
  }
}

const cats = await client.callTool({
  name: "xui_player_browse",
  arguments: { username, password, resource: "get_live_categories", response_format: "json" },
});
const c = parsed(cats);
check("live categories readable", c !== null,
  c ? `${c.total} category(ies)` : text(cats).slice(0, 70));

const streams = await client.callTool({
  name: "xui_player_browse",
  arguments: { username, password, resource: "get_live_streams", limit: 2, response_format: "json" },
});
const s = parsed(streams);
check("live streams readable", s !== null, s ? `${s.total} stream(s)` : text(streams).slice(0, 70));
check("pagination applied", s !== null && s.count <= 2 && typeof s.has_more === "boolean");

// A real account may well have VOD, so assert the response shape rather than a
// count. An empty catalogue is one valid shape among several.
const vod = await client.callTool({
  name: "xui_player_browse",
  arguments: { username, password, resource: "get_vod_streams", response_format: "json" },
});
const v = parsed(vod);
check("vod catalogue returns a well-formed list", v !== null && Array.isArray(v.items) &&
  typeof v.total === "number" && v.items.length === v.count,
  v ? `${v.total} item(s)` : text(vod).slice(0, 70));

if (s && Array.isArray(s.items) && s.items.length > 0 && s.items[0]?.stream_id != null) {
  const epg = await client.callTool({
    name: "xui_player_epg",
    arguments: { username, password, stream_id: String(s.items[0].stream_id), response_format: "json" },
  });
  const e = parsed(epg);
  check("epg readable", e !== null, e ? `${e.count} listing(s)` : text(epg).slice(0, 70));
}

// A transport failure would also produce isError, which would pass a looser
// assertion for the wrong reason. Require the panel to answer and say no.
const bad = await client.callTool({
  name: "xui_player_check_line",
  arguments: { username, password: "definitely-wrong", response_format: "json" },
});
const b = parsed(bad);
check("wrong password is rejected by the panel, not by a transport error",
  b !== null && b.authenticated === false,
  b === null ? `unexpected error: ${text(bad).slice(0, 60)}` : `auth=${b.authenticated}`);

await client.close();
console.log(failures === 0 ? "\nPlayer validation passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
