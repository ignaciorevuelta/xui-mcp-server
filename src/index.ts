#!/usr/bin/env node
/**
 * MCP server for the XUI.ONE IPTV panel (reseller API surface).
 *
 * Exposes line lifecycle (read/create/renew/delete), trial creation and
 * reseller credit management as MCP tools.
 *
 * Safety: the panel behind this server holds real customer subscriptions.
 * Every mutating tool is disabled unless `XUI_ALLOW_WRITES=true`, and
 * deletion additionally requires `XUI_ALLOW_DELETE=true`. Read-only tools
 * always work, so the default configuration is safe to point at production.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";

import { loadConfig } from "./config.js";
import {
  XuiError,
  addResellerCredits,
  createLine,
  deleteLine,
  editLine,
  getLine,
  getUser,
  userInfo,
} from "./client.js";
import {
  LINE_STATE_ACTIONS,
  LIST_ACTIONS,
  LOG_ACTIONS,
  adminCall,
  paginate,
} from "./admin.js";
import type { SshTarget } from "./ssh.js";
import { install, preflight, repair, status } from "./provision.js";

const SERVER_NAME = "xui-mcp-server";
const SERVER_VERSION = "0.1.0";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ResponseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: 'markdown' for human-readable, 'json' for machine-readable");

const lineIdField = z
  .string()
  .regex(/^\d+$/, "Line id must be the panel's numeric id, e.g. '1612073'")
  .describe("Numeric line id as shown on the panel (not the username)");

const packageIdField = z
  .number()
  .int()
  .positive()
  .describe("XUI package id from the panel's create-line dropdown, e.g. 134");

/** Alphabet excludes look-alike characters so credentials survive being read aloud. */
const CRED_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";

function randomCredential(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CRED_ALPHABET[bytes[i]! % CRED_ALPHABET.length];
  }
  return out;
}

function respond(output: Record<string, unknown>, markdown: string, format: string): ToolResult {
  return {
    content: [{ type: "text", text: format === "json" ? JSON.stringify(output, null, 2) : markdown }],
    structuredContent: output,
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function toErrorResult(error: unknown): ToolResult {
  if (error instanceof XuiError) return fail(error.message);
  if (error instanceof z.ZodError) {
    return fail(
      `The panel's response did not match the expected shape: ${error.issues
        .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
        .join("; ")}`,
    );
  }
  return fail(error instanceof Error ? error.message : String(error));
}

/** Returns an error result when the relevant write gate is closed, else null. */
function writeGate(kind: "write" | "delete"): ToolResult | null {
  const cfg = loadConfig();
  if (!cfg.allowWrites) {
    return fail(
      "Mutating actions are disabled. This server starts read-only so it is safe to point " +
        "at a production panel. Set XUI_ALLOW_WRITES=true in the server environment to enable " +
        "line creation and renewal.",
    );
  }
  if (kind === "delete" && !cfg.allowDelete) {
    return fail(
      "Line deletion is disabled. Deleting a line cancels a customer's service and cannot be " +
        "undone from this API. Set XUI_ALLOW_DELETE=true in the server environment to enable it.",
    );
  }
  return null;
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

// ---------------------------------------------------------------------------
// Read-only tools
// ---------------------------------------------------------------------------

server.registerTool(
  "xui_get_line",
  {
    title: "Get XUI line",
    description: `Fetch the live state of a single IPTV line from the XUI panel by its numeric id.

Args:
  - line_id (string): Numeric panel line id, e.g. "1612073". This is NOT the username.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  {
    "id": string,              // Line id
    "username": string,        // Line username (IPTV login)
    "password": string,        // Line password
    "exp_date": string,        // Expiry as ISO-8601 UTC
    "exp_date_unix": number,   // Expiry as unix seconds, as the panel stores it
    "package_id": number,      // XUI package the line is on
    "status": string,          // "active" | "blocked" | "expired"
    "max_connections": number, // Simultaneous device limit
    "is_trial": boolean        // Whether this is a demo/trial line
  }

Examples:
  - Use when: "Is line 1612073 still active and when does it expire?"
  - Use when: You need a line's package id before renewing it.
  - Don't use when: You only know the customer's username — this API looks up by id only.

Error Handling:
  - "Panel rejected action 'get_line'" means the id does not exist or the key lacks access to it.`,
    inputSchema: { line_id: lineIdField, response_format: ResponseFormat },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ line_id, response_format }): Promise<ToolResult> => {
    try {
      const line = await getLine(line_id);
      const output = {
        id: line.id,
        username: line.username,
        password: line.password,
        exp_date: line.expDate,
        exp_date_unix: line.expDateUnix,
        package_id: line.packageId,
        status: line.status,
        max_connections: line.maxConnections,
        is_trial: line.isTrial,
      };
      const md = [
        `# Line ${line.id} (${line.username})`,
        "",
        `- **Status**: ${line.status}`,
        `- **Expires**: ${line.expDate}`,
        `- **Package**: ${line.packageId}`,
        `- **Max connections**: ${line.maxConnections}`,
        `- **Trial**: ${line.isTrial ? "yes" : "no"}`,
      ].join("\n");
      return respond(output, md, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_get_user",
  {
    title: "Get XUI user or sub-reseller",
    description: `Fetch a panel user (typically a sub-reseller) by numeric id, including their credit balance.

Args:
  - user_id (string): Numeric panel user id, e.g. "3012"
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  {
    "id": string,        // User id
    "username": string,  // Panel login
    "credits": number,   // Credit balance held by this user
    "status": string     // Panel-reported status
  }

Examples:
  - Use when: "How many credits does reseller 4821 have left?"
  - Don't use when: You want the credit pool of the API key's own account — use xui_user_info.

Error Handling:
  - Some panels restrict get_user to the key owner's sub-tree; a rejection means the id is
    outside that scope or does not exist.`,
    inputSchema: {
      user_id: z
        .string()
        .regex(/^\d+$/, "User id must be numeric, e.g. '3012'")
        .describe("Numeric panel user/reseller id"),
      response_format: ResponseFormat,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ user_id, response_format }): Promise<ToolResult> => {
    try {
      const user = await getUser(user_id);
      const output = {
        id: user.id,
        username: user.username,
        credits: user.credits,
        status: user.status,
      };
      const md = [
        `# User ${user.id} (${user.username})`,
        "",
        `- **Credits**: ${user.credits}`,
        `- **Status**: ${user.status || "(not reported)"}`,
      ].join("\n");
      return respond(output, md, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_user_info",
  {
    title: "Get API key owner and credit pool",
    description: `Return the account that owns the configured API key, including its credit balance.

The panel ignores any id passed to this action and always answers for the key owner, so the
returned 'credits' value is the master pool that line creation draws down. Use this to check
capacity before provisioning, and to verify credentials are configured correctly.

Args:
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  {
    "id": string,        // Owning account id
    "username": string,  // Owning account login
    "credits": number,   // Master credit pool available for creating lines
    "status": string     // Panel-reported status
  }

Examples:
  - Use when: "Do we have enough credits to provision 10 more lines?"
  - Use when: Smoke-testing that XUI_URL and XUI_API_KEY are correct.
  - Don't use when: You want a specific sub-reseller's balance — use xui_get_user.`,
    inputSchema: { response_format: ResponseFormat },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ response_format }): Promise<ToolResult> => {
    try {
      const user = await userInfo();
      const output = {
        id: user.id,
        username: user.username,
        credits: user.credits,
        status: user.status,
      };
      const md = [
        `# API key owner: ${user.username} (${user.id})`,
        "",
        `- **Credit pool**: ${user.credits}`,
        `- **Status**: ${user.status || "(not reported)"}`,
      ].join("\n");
      return respond(output, md, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Mutating tools (gated by XUI_ALLOW_WRITES)
// ---------------------------------------------------------------------------

server.registerTool(
  "xui_create_line",
  {
    title: "Create XUI line",
    description: `Create a new IPTV line on the panel. Consumes credits from the API key owner's pool.

Credentials are generated server-side using an unambiguous alphabet unless you supply them.
The line's duration comes from the package, not from this call.

Requires XUI_ALLOW_WRITES=true.

Args:
  - package_id (number): XUI package id, e.g. 134
  - username (string, optional): Line username; generated if omitted
  - password (string, optional): Line password; generated if omitted
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  {
    "id": string,            // New line id — store this, it is the handle for all later calls
    "username": string,
    "password": string,
    "package_id": number,
    "exp_date": string,      // ISO-8601 UTC
    "exp_date_unix": number
  }

Examples:
  - Use when: "Provision a Pro line for a customer who just paid" -> package_id=134
  - Don't use when: Renewing an existing customer — use xui_renew_line so they keep their
    credentials instead of getting a second account.

Error Handling:
  - A rejection mentioning credits means the pool is empty; check with xui_user_info.
  - A rejection on username means it is already taken; retry without supplying one.`,
    inputSchema: {
      package_id: packageIdField,
      username: z
        .string()
        .min(3)
        .max(64)
        .regex(/^[A-Za-z0-9_.-]+$/, "Username may only contain letters, digits, _ . and -")
        .optional()
        .describe("Line username; a random one is generated when omitted"),
      password: z
        .string()
        .min(4)
        .max(64)
        .optional()
        .describe("Line password; a random one is generated when omitted"),
      response_format: ResponseFormat,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ package_id, username, password, response_format }): Promise<ToolResult> => {
    const gate = writeGate("write");
    if (gate) return gate;
    try {
      const created = await createLine({
        packageId: package_id,
        username: username ?? randomCredential(10),
        password: password ?? randomCredential(12),
      });
      const output = {
        id: created.id,
        username: created.username,
        password: created.password,
        package_id: created.packageId,
        exp_date: created.expDate,
        exp_date_unix: created.expDateUnix,
      };
      const md = [
        `# Line created: ${created.id}`,
        "",
        `- **Username**: ${created.username}`,
        `- **Password**: ${created.password}`,
        `- **Package**: ${created.packageId}`,
        `- **Expires**: ${created.expDate}`,
      ].join("\n");
      return respond(output, md, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_create_trial",
  {
    title: "Create XUI trial line",
    description: `Create a trial/demo line. The trial's duration is baked into the trial package itself —
this API has no separate duration parameter, so pick the package that matches the length you want.

Requires XUI_ALLOW_WRITES=true.

Args:
  - package_id (number): A trial package id from the panel, e.g. 82 for a 5-hour demo
  - username (string, optional): generated if omitted
  - password (string, optional): generated if omitted
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: same shape as xui_create_line.

Examples:
  - Use when: "Give this prospect a 5-hour demo" -> package_id=<your 5h trial package>
  - Don't use when: The package is a normal paid package — use xui_create_line so the line is
    not flagged as a trial.

Error Handling:
  - If the resulting expiry is far in the future, the package id was not a trial package.`,
    inputSchema: {
      package_id: z
        .number()
        .int()
        .positive()
        .describe("Trial package id from the panel's trial list, e.g. 82"),
      username: z.string().min(3).max(64).optional().describe("Generated when omitted"),
      password: z.string().min(4).max(64).optional().describe("Generated when omitted"),
      response_format: ResponseFormat,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ package_id, username, password, response_format }): Promise<ToolResult> => {
    const gate = writeGate("write");
    if (gate) return gate;
    try {
      const created = await createLine({
        packageId: package_id,
        username: username ?? randomCredential(10),
        password: password ?? randomCredential(12),
        trial: true,
      });
      const output = {
        id: created.id,
        username: created.username,
        password: created.password,
        package_id: created.packageId,
        exp_date: created.expDate,
        exp_date_unix: created.expDateUnix,
      };
      const md = [
        `# Trial created: ${created.id}`,
        "",
        `- **Username**: ${created.username}`,
        `- **Password**: ${created.password}`,
        `- **Expires**: ${created.expDate}`,
      ].join("\n");
      return respond(output, md, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_renew_line",
  {
    title: "Renew or change an XUI line's package",
    description: `Apply a package to an existing line, which extends its expiry. This is the correct way to
renew a customer: it keeps their existing username and password instead of minting a new account.

Works on expired lines as well as active ones — renewing an expired line reactivates it.

Requires XUI_ALLOW_WRITES=true.

Args:
  - line_id (string): Numeric line id, e.g. "1612073"
  - package_id (number): Package to apply. Pass the line's current package to renew like-for-like,
    or a different one to change plan.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  {
    "id": string,
    "exp_date": string,      // New expiry, ISO-8601 UTC
    "exp_date_unix": number
  }

Examples:
  - Use when: "Carlos paid for another year on line 1987094" -> read the package via
    xui_get_line, then call this with the same package_id.
  - Don't use when: The customer has no line at all — use xui_create_line.

Error Handling:
  - Verify the new expiry in the response; a package id that does not exist may be silently
    accepted by some panels without extending anything.`,
    inputSchema: {
      line_id: lineIdField,
      package_id: packageIdField,
      response_format: ResponseFormat,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ line_id, package_id, response_format }): Promise<ToolResult> => {
    const gate = writeGate("write");
    if (gate) return gate;
    try {
      const edited = await editLine(line_id, package_id);
      const output = {
        id: edited.id,
        exp_date: edited.expDate,
        exp_date_unix: edited.expDateUnix,
      };
      const md = `# Line ${edited.id} renewed\n\n- **New expiry**: ${edited.expDate}`;
      return respond(output, md, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_add_reseller_credits",
  {
    title: "Top up a sub-reseller's credits",
    description: `Add credits to a sub-reseller's balance on the panel.

Requires XUI_ALLOW_WRITES=true.

Args:
  - reseller_id (string): Numeric sub-reseller id, e.g. "4821"
  - credits (number): Positive whole number of credits to add
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  {
    "reseller_id": string,
    "credits_added": number,
    "new_balance": number | null   // null when the panel did not echo a balance back
  }

Examples:
  - Use when: "Reseller 4821 bought a 100-credit pack"

Error Handling:
  - A null new_balance is not a failure: the panel accepted the top-up but did not report the
    resulting total. Confirm with xui_get_user if the number matters.`,
    inputSchema: {
      reseller_id: z
        .string()
        .regex(/^\d+$/, "Reseller id must be numeric")
        .describe("Numeric sub-reseller id"),
      credits: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .describe("Credits to add; must be a positive whole number"),
      response_format: ResponseFormat,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ reseller_id, credits, response_format }): Promise<ToolResult> => {
    const gate = writeGate("write");
    if (gate) return gate;
    try {
      const balance = await addResellerCredits(reseller_id, credits);
      const output = {
        reseller_id,
        credits_added: credits,
        new_balance: balance,
      };
      const md = [
        `# Credited reseller ${reseller_id}`,
        "",
        `- **Added**: ${credits}`,
        `- **New balance**: ${balance ?? "not reported by the panel"}`,
      ].join("\n");
      return respond(output, md, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_delete_line",
  {
    title: "Delete an XUI line",
    description: `Permanently delete a line from the panel. This cancels the customer's service immediately
and cannot be undone through this API.

Requires BOTH XUI_ALLOW_WRITES=true and XUI_ALLOW_DELETE=true.

Prefer letting a line expire over deleting it — an expired line can be reactivated with
xui_renew_line and keeps its history; a deleted one cannot.

Args:
  - line_id (string): Numeric line id to delete
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  { "id": string, "deleted": true }

Examples:
  - Use when: Cleaning up expired demo lines that were never converted.
  - Don't use when: A customer is late on payment — let it expire instead.`,
    inputSchema: { line_id: lineIdField, response_format: ResponseFormat },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ line_id, response_format }): Promise<ToolResult> => {
    const gate = writeGate("delete");
    if (gate) return gate;
    try {
      await deleteLine(line_id);
      const output = { id: line_id, deleted: true };
      return respond(output, `# Line ${line_id} deleted`, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Admin API tools
//
// The admin surface has ~60 actions. Registering one tool each would drown the
// agent's tool list, so related actions are grouped behind an `action` enum and
// the long tail is reachable through xui_admin_call.
// ---------------------------------------------------------------------------

/** Beyond this, list responses are truncated with an explicit note. */
const CHARACTER_LIMIT = 25_000;

function respondList(
  output: Record<string, unknown>,
  markdown: string,
  format: string,
): ToolResult {
  const text = format === "json" ? JSON.stringify(output, null, 2) : markdown;
  if (text.length <= CHARACTER_LIMIT) return respond(output, markdown, format);

  const items = Array.isArray(output.items) ? output.items : [];
  const kept = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
  const truncated = {
    ...output,
    items: kept,
    truncated: true,
    truncation_note:
      `Response trimmed from ${items.length} to ${kept.length} rows to stay under ` +
      `${CHARACTER_LIMIT} characters. Use 'limit' and 'offset' to page through the rest.`,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(truncated, null, 2) }],
    structuredContent: truncated,
  };
}

server.registerTool(
  "xui_admin_list",
  {
    title: "List XUI resources (Admin API)",
    description: `List any collection the panel's Admin API exposes: users, lines, streams, movies, series, bouquets, categories, packages, servers, providers, access codes, EPG sources or HMAC keys.

Requires XUI_ADMIN_URL and XUI_ADMIN_API_KEY (an access code of type 'Admin API' plus an administrator's api_key). These are separate from the reseller credentials.

Args:
  - resource (enum): one of get_users, get_lines, get_streams, get_channels, get_movies,
    get_series_list, get_episodes, get_bouquets, get_categories, get_packages, get_servers,
    get_providers, get_access_codes, get_epgs, get_hmacs
  - limit (number): rows to return, 1-500 (default: 50)
  - offset (number): rows to skip (default: 0)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  {
    "resource": string,
    "total": number,          // rows the panel returned in full
    "count": number,          // rows in this page
    "offset": number,
    "items": object[],        // raw panel rows, field names as the panel reports them
    "has_more": boolean,
    "next_offset": number     // present only when has_more
  }

Examples:
  - Use when: "How many lines exist and which are disabled?" -> resource=get_lines
  - Use when: Building an integration and you need the real field names a resource has.
  - Don't use when: You only manage one reseller's lines — xui_get_line needs no admin key.

Note: the panel ignores limit/offset server-side and returns everything, so paging is
applied here. Very large collections are trimmed with a truncation note.`,
    inputSchema: {
      resource: z.enum(LIST_ACTIONS).describe("Which collection to read"),
      limit: z.number().int().min(1).max(500).default(50).describe("Rows to return"),
      offset: z.number().int().min(0).default(0).describe("Rows to skip"),
      response_format: ResponseFormat,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ resource, limit, offset, response_format }): Promise<ToolResult> => {
    try {
      const result = await adminCall(resource);
      const all = result.items ?? [];
      const { page, total, hasMore, nextOffset } = paginate(all, limit, offset);
      const output = {
        resource,
        total,
        count: page.length,
        offset,
        items: page,
        has_more: hasMore,
        ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
      };
      const md = [
        `# ${resource}`,
        "",
        `${total} row(s) total, showing ${page.length} from offset ${offset}.`,
        "",
        "```json",
        JSON.stringify(page, null, 2).slice(0, 4000),
        "```",
      ].join("\n");
      return respondList(output, md, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_admin_logs",
  {
    title: "Read XUI panel logs (Admin API)",
    description: `Read one of the panel's diagnostic feeds. This is the fastest way to find out why a client, line or stream is misbehaving.

Requires the Admin API credentials.

Args:
  - feed (enum): activity_logs, live_connections, credit_logs, client_logs, user_logs,
    stream_errors, watch_output, system_logs, login_logs, restream_logs, mag_events
  - limit (number): rows to return, 1-500 (default: 50)
  - offset (number): rows to skip (default: 0)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns the same envelope as xui_admin_list: total, count, offset, items, has_more.

Examples:
  - Use when: "Who is watching right now?" -> feed=live_connections
  - Use when: "Why did this stream drop?" -> feed=stream_errors
  - Use when: Auditing a reseller's credit movements -> feed=credit_logs`,
    inputSchema: {
      feed: z.enum(LOG_ACTIONS).describe("Which log feed to read"),
      limit: z.number().int().min(1).max(500).default(50).describe("Rows to return"),
      offset: z.number().int().min(0).default(0).describe("Rows to skip"),
      response_format: ResponseFormat,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ feed, limit, offset, response_format }): Promise<ToolResult> => {
    try {
      const result = await adminCall(feed);
      const all = result.items ?? [];
      const { page, total, hasMore, nextOffset } = paginate(all, limit, offset);
      const output = {
        feed,
        total: result.total ?? total,
        count: page.length,
        offset,
        items: page,
        has_more: hasMore,
        ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
      };
      const md = [
        `# ${feed}`,
        "",
        `${total} row(s), showing ${page.length} from offset ${offset}.`,
        "",
        "```json",
        JSON.stringify(page, null, 2).slice(0, 4000),
        "```",
      ].join("\n");
      return respondList(output, md, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_admin_set_line_state",
  {
    title: "Enable, disable or ban an XUI line (Admin API)",
    description: `Change a line's access state without deleting it. Preferred over deletion: the line keeps its credentials and history and can be reversed.

Requires the Admin API credentials and XUI_ALLOW_WRITES=true.

Args:
  - line_id (string): numeric line id
  - state (enum): 'enable_line', 'disable_line', 'ban_line', 'unban_line'
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "line_id": string, "state": string, "applied": true }

Examples:
  - Use when: A customer's payment bounced and you want to suspend rather than cancel
    -> state=disable_line, reversed later with enable_line.
  - Use when: Credential sharing is suspected -> state=ban_line.
  - Don't use when: The customer is simply late — letting the line expire is gentler.`,
    inputSchema: {
      line_id: lineIdField,
      state: z.enum(LINE_STATE_ACTIONS).describe("State transition to apply"),
      response_format: ResponseFormat,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ line_id, state, response_format }): Promise<ToolResult> => {
    const gate = writeGate("write");
    if (gate) return gate;
    try {
      await adminCall(state, { id: line_id });
      const output = { line_id, state, applied: true };
      return respond(output, `# Line ${line_id}: ${state.replace("_line", "")}d`, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_admin_control_stream",
  {
    title: "Start or stop an XUI stream (Admin API)",
    description: `Start or stop the transcoder for a live stream.

Requires the Admin API credentials and XUI_ALLOW_WRITES=true.

Args:
  - stream_id (string): numeric stream id
  - operation (enum): 'start_stream' or 'stop_stream'
  - server_id (number): streaming server the stream runs on (default: 1)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "stream_id": string, "operation": string, "server_id": number, "applied": true }

Examples:
  - Use when: A channel is dead and you want to bounce it -> stop_stream then start_stream.
  - Use when: Bringing an on-demand stream up before a client connects, so the first
    request does not fail while the transcoder probes the source.

Error Handling:
  - Success only means the panel accepted the command. Confirm with
    xui_admin_logs(feed='stream_errors') if the stream does not come up.`,
    inputSchema: {
      stream_id: z
        .string()
        .regex(/^\d+$/, "Stream id must be numeric")
        .describe("Numeric stream id"),
      operation: z.enum(["start_stream", "stop_stream"]).describe("What to do"),
      server_id: z.number().int().positive().default(1).describe("Streaming server id"),
      response_format: ResponseFormat,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ stream_id, operation, server_id, response_format }): Promise<ToolResult> => {
    const gate = writeGate("write");
    if (gate) return gate;
    try {
      await adminCall(operation, { id: stream_id, server_id: String(server_id) });
      const output = { stream_id, operation, server_id, applied: true };
      const verb = operation === "start_stream" ? "started" : "stopped";
      return respond(output, `# Stream ${stream_id} ${verb}`, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_admin_call",
  {
    title: "Call any XUI Admin API action (advanced)",
    description: `Escape hatch for the parts of the Admin API the dedicated tools do not cover — creating and editing users, lines, bouquets, categories, packages, streams, providers, EPG sources, MAG and Enigma devices, access codes and HMAC keys.

Requires the Admin API credentials. Any action other than a 'get_*' one also requires
XUI_ALLOW_WRITES=true, and a 'delete_*' action additionally requires XUI_ALLOW_DELETE=true.

Args:
  - action (string): panel action name, e.g. 'create_bouquet', 'edit_user', 'reload_epg'
  - params (object): action parameters as string values, e.g. { "id": "12", "package": "134" }
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "action": string, "data": unknown, "items": array | null }

Quirks that will otherwise waste your time:
  - Array parameters need PHP bracket notation: pass "bouquets[]", "category_id[]",
    "stream_source[]", "server_id[]". A JSON string is silently ignored and the field
    is left empty.
  - Output formats are ids, not names: 1 = HLS/m3u8, 2 = MPEGTS/ts, 3 = RTMP. A line
    whose allowed_outputs holds names is refused at playback with USER_DISALLOW_EXT.
  - Edit actions overwrite unspecified fields with blanks. Always send the full set.
  - Some list actions return a bare JSON array rather than the usual envelope.

Examples:
  - Use when: "Create a bouquet called Sports" -> action='create_bouquet',
    params={ "bouquet_name": "Sports" }
  - Use when: "Suspend reseller 4821" -> action='disable_user', params={ "id": "4821" }
  - Don't use when: A dedicated tool exists — it validates input and explains failures better.`,
    inputSchema: {
      action: z
        .string()
        .min(2)
        .max(64)
        .regex(/^[a-z_][a-z0-9_]*$/, "Action must be a lower_snake_case panel action name")
        .describe("Panel action name, e.g. 'create_bouquet'"),
      params: z
        .record(z.string())
        .default({})
        .describe("Action parameters; values are sent verbatim as query parameters"),
      response_format: ResponseFormat,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ action, params, response_format }): Promise<ToolResult> => {
    const isRead = action.startsWith("get_") || action.endsWith("_logs") || action === "user_info";
    if (!isRead) {
      const gate = writeGate(action.startsWith("delete_") ? "delete" : "write");
      if (gate) return gate;
    }
    try {
      const result = await adminCall(action, params);
      const output = { action, data: result.data ?? null, items: result.items };
      const md = [
        `# ${action}`,
        "",
        "```json",
        JSON.stringify(result.data ?? null, null, 2).slice(0, 4000),
        "```",
      ].join("\n");
      return respondList(output, md, response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Server provisioning
//
// These tools open a root SSH session on another machine. They are disabled
// unless XUI_ALLOW_PROVISIONING=true, and can be pinned to specific hosts with
// XUI_PROVISION_HOSTS.
// ---------------------------------------------------------------------------

const sshFields = {
  host: z.string().min(1).describe("Target hostname or IP"),
  port: z.number().int().min(1).max(65535).default(22).describe("SSH port"),
  username: z.string().min(1).default("root").describe("SSH user; the install needs root"),
  private_key_path: z
    .string()
    .optional()
    .describe("Path to a private key on the machine running this server. Preferred over a password."),
  password: z
    .string()
    .optional()
    .describe("SSH password, if no key is available. Prefer private_key_path."),
};

const sshTarget = (a: {
  host: string;
  port: number;
  username: string;
  private_key_path?: string;
  password?: string;
}): SshTarget => ({
  host: a.host,
  port: a.port,
  username: a.username,
  privateKeyPath: a.private_key_path,
  password: a.password,
});

function stepsMarkdown(title: string, steps: { label: string; ok: boolean; detail: string }[]): string {
  const lines = [`# ${title}`, ""];
  for (const s of steps) {
    lines.push(`## ${s.ok ? "OK" : "FAILED"} — ${s.label}`, "", "```", s.detail, "```", "");
  }
  return lines.join("\n");
}

server.registerTool(
  "xui_server_preflight",
  {
    title: "Check whether a server can host XUI",
    description: `Inspect a target machine over SSH and report whether it can host an XUI.ONE panel. Read-only — it runs no installer and changes nothing.

Requires XUI_ALLOW_PROVISIONING=true.

Args:
  - host, port (default 22), username (default 'root')
  - private_key_path or password
  - response_format ('markdown' | 'json')

Returns:
  {
    "os": string, "arch": string, "virtualisation": string,
    "cpu_cores": number, "memory_mb": number, "disk_free_gb": number,
    "already_installed": boolean,
    "blockers": string[],   // must be resolved before installing
    "warnings": string[]    // will work, but below what the panel expects
  }

Examples:
  - Use when: You have a fresh VPS and want to know if it is suitable before spending
    an hour on the install.
  - Use when: An install failed and you want to know whether the box was ever viable.

Blockers you should expect to see: a non-x86_64 architecture (XUI ships no ARM build),
OpenVZ or LXC virtualisation, an existing /home/xui, or ports 80/443/8080 already taken.`,
    inputSchema: { ...sshFields, response_format: ResponseFormat },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      const p = await preflight(sshTarget(args));
      const output = {
        os: p.os,
        arch: p.arch,
        virtualisation: p.virtualisation,
        cpu_cores: p.cpuCores,
        memory_mb: p.memoryMb,
        disk_free_gb: p.diskFreeGb,
        already_installed: p.alreadyInstalled,
        blockers: p.blockers,
        warnings: p.warnings,
        suitable: p.blockers.length === 0,
      };
      const md = [
        `# Preflight: ${args.host}`,
        "",
        `- **OS**: ${p.os || "unknown"}  **Arch**: ${p.arch}  **Virt**: ${p.virtualisation}`,
        `- **CPU**: ${p.cpuCores} cores  **RAM**: ${p.memoryMb} MB  **Disk free**: ${p.diskFreeGb} GB`,
        `- **Panel already present**: ${p.alreadyInstalled ? "yes" : "no"}`,
        "",
        p.blockers.length ? `## Blockers\n${p.blockers.map((b) => `- ${b}`).join("\n")}` : "## Blockers\nNone.",
        "",
        p.warnings.length ? `## Warnings\n${p.warnings.map((w) => `- ${w}`).join("\n")}` : "",
      ].join("\n");
      return respond(output, md, args.response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_server_install",
  {
    title: "Install XUI.ONE on a server",
    description: `Provision a clean server into a working XUI.ONE panel over SSH, applying the fixes a stock install needs to actually serve video.

Requires XUI_ALLOW_PROVISIONING=true and XUI_ALLOW_WRITES=true.

Preflight runs automatically and **refuses to start if it reports any blocker** — an existing
/home/xui, a non-x86_64 architecture, unsupported virtualisation, or occupied ports. Pass
force=true only if you are certain; it will not undo whatever is already on the box.

**This runs for a long time** — 30 to 60 minutes. The dependency stage compiles PHP and ffmpeg.

**What it executes:** XUI.ONE is abandonware with no official download, so the payload and
the licence patch come from community mirrors and run as root. Both are pinned by SHA-256
and the install aborts on a mismatch, but you are still executing unsigned third-party
binaries on the target machine. Do not point this at anything you care about.

Args:
  - host, port, username, private_key_path or password
  - harden_ssh (boolean, default true): install public_key and disable password auth
  - public_key (string, optional): the key to install when harden_ssh is on
  - response_format ('markdown' | 'json')

Steps, in order: system update; SSH hardening; payload download with hash check; dependencies;
panel install; /tmp permissions; 2025 licence patch; disable the 60-second restart cron;
raise stream probe sizes; firewall; restart and verify.

Returns: { "steps": [{ "label", "ok", "detail" }], "all_ok": boolean }

The setup URL and MySQL credentials are written to /root/xui-install/credentials.txt on the
target and appear in the install step's output. Finish setup in a browser to create the admin
account, then use xui_server_status to confirm health.`,
    inputSchema: {
      ...sshFields,
      harden_ssh: z.boolean().default(true).describe("Install a key and turn off password auth"),
      public_key: z
        .string()
        .max(1024)
        .regex(
          /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/]+={0,2}(\s+\S*)?$/,
          "Must be a single OpenSSH public key, e.g. 'ssh-ed25519 AAAAC3Nza... comment'",
        )
        .optional()
        .describe("Public key to authorise, e.g. 'ssh-ed25519 AAAA... you@host'"),
      force: z
        .boolean()
        .default(false)
        .describe("Install even when preflight reports blockers, such as an existing panel"),
      response_format: ResponseFormat,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args): Promise<ToolResult> => {
    const gate = writeGate("write");
    if (gate) return gate;
    try {
      const target = sshTarget(args);

      // Preflight is not advisory here. Installing over an existing panel, or onto
      // an architecture that cannot run it, wastes an hour and can damage a working
      // box, so blockers stop the run unless the caller overrides deliberately.
      if (!args.force) {
        const pre = await preflight(target);
        if (pre.blockers.length > 0) {
          return fail(
            `Refusing to install on ${args.host}:\n` +
              pre.blockers.map((b) => `  - ${b}`).join("\n") +
              `\n\nUse xui_server_repair for a box that already has a panel, or pass ` +
              `force=true to install anyway (it will not undo what is already there).`,
          );
        }
      }

      const steps = await install(target, {
        hardenSsh: args.harden_ssh,
        publicKey: args.public_key,
      });
      const output = { steps, all_ok: steps.every((s) => s.ok) };
      return respond(output, stepsMarkdown(`Install on ${args.host}`, steps), args.response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_server_status",
  {
    title: "Health of an installed XUI panel",
    description: `Report the health of a panel over SSH, checking the things that actually break: the licence, the restart loop, the file cache and the running processes. Read-only.

Requires XUI_ALLOW_PROVISIONING=true.

Args: host, port, username, private_key_path or password, response_format

Returns:
  {
    "service": string,                 // systemd state of xuione
    "nginx_workers": number, "php_fpm": number, "ffmpeg_running": number,
    "licence": string,                 // e.g. "License expires: 2038-01-19"
    "restarts_last_three_min": number, // >1 means the restart cron is bouncing the service
    "cache_lines": number,             // 0 means auth.php will refuse playback
    "restart_cron_present": boolean,
    "healthy": boolean,
    "issues": string[]                 // plain-language description of each problem
  }

Examples:
  - Use when: Clients report channels not playing — check restarts and cache_lines first.
  - Use when: Confirming an install or repair actually worked.

Anything reported in 'issues' is fixable with xui_server_repair.`,
    inputSchema: { ...sshFields, response_format: ResponseFormat },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      const s = await status(sshTarget(args));
      const output = {
        service: s.service,
        nginx_workers: s.nginxWorkers,
        php_fpm: s.phpFpm,
        ffmpeg_running: s.ffmpegRunning,
        licence: s.licence,
        restarts_last_three_min: s.restartsLastThreeMin,
        cache_lines: s.cacheLines,
        restart_cron_present: s.restartCronPresent,
        healthy: s.healthy,
        issues: s.issues,
      };
      const md = [
        `# Panel status: ${args.host}`,
        "",
        `- **Service**: ${s.service}  **nginx**: ${s.nginxWorkers}  **php-fpm**: ${s.phpFpm}  **ffmpeg**: ${s.ffmpegRunning}`,
        `- **Licence**: ${s.licence || "(not reported)"}`,
        `- **Restarts in 3 min**: ${s.restartsLastThreeMin}`,
        `- **Cached lines**: ${s.cacheLines}`,
        "",
        s.healthy ? "Healthy." : `## Issues\n${s.issues.map((i) => `- ${i}`).join("\n")}`,
      ].join("\n");
      return respond(output, md, args.response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  "xui_server_repair",
  {
    title: "Apply known fixes to an XUI panel",
    description: `Fix an installed panel that does not serve video. Every step is idempotent, so it is safe to run repeatedly and safe to run on a healthy panel.

Requires XUI_ALLOW_PROVISIONING=true and XUI_ALLOW_WRITES=true.

What it repairs, and why each one matters:
  - **/tmp permissions** back to 1777 — PHP puts its Zend semaphore there and php-fpm
    refuses to start without it.
  - **Licence patch** to the 2025 build — the older patch leaves the panel failing its
    licence check forever.
  - **The 60-second restart cron** (root_signals.php) — it restarts the whole service every
    minute, which kills streams mid-flight and stops the cache from ever being built.
  - **Stream probe sizes** — the default is a quarter-second of video, too little for ffmpeg
    to identify codecs, so streams never start.
  - **Output formats to ids** — lines and packages holding ["ts"] instead of [1,2,3] are
    refused at playback with USER_DISALLOW_EXT, which the panel reports as a bare 404.

Args: host, port, username, private_key_path or password, response_format

Returns: { "steps": [{ "label", "ok", "detail" }], "all_ok": boolean }

Run xui_server_status afterwards to confirm. Note that disabling the restart cron also stops
the scheduled jobs it dispatches (EPG refresh, stats, cleanup); the original is kept at
/root/root_signals.php.bak if you decide you want it back.`,
    inputSchema: { ...sshFields, response_format: ResponseFormat },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (args): Promise<ToolResult> => {
    const gate = writeGate("write");
    if (gate) return gate;
    try {
      const steps = await repair(sshTarget(args));
      const output = { steps, all_ok: steps.every((s) => s.ok) };
      return respond(output, stepsMarkdown(`Repair on ${args.host}`, steps), args.response_format);
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (error) {
    console.error(`[${SERVER_NAME}] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; diagnostics must go to stderr.
  console.error(
    `[${SERVER_NAME}] ready — writes ${cfg.allowWrites ? "ENABLED" : "disabled"}, ` +
      `delete ${cfg.allowDelete ? "ENABLED" : "disabled"}, ` +
      `admin API ${cfg.adminUrl && cfg.adminApiKey ? "configured" : "not configured"}`,
  );
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] fatal:`, error);
  process.exit(1);
});
