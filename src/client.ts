/**
 * XUI.ONE reseller API client.
 *
 * The panel exposes a single endpoint that switches behaviour on the `action`
 * query parameter and authenticates with `api_key`. Successful responses are
 * `{ status: "STATUS_SUCCESS", data?: {...} }`; failures are
 * `{ status: "STATUS_FAILURE", error: "..." }`.
 *
 * Field types are inconsistent across actions — the same field arrives as a
 * number in one response and a numeric string in another — so every value is
 * coerced rather than trusted.
 */

import { z } from "zod";
import { loadConfig } from "./config.js";

export class XuiError extends Error {
  constructor(
    message: string,
    readonly action: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "XuiError";
  }
}

const envelopeSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  data: z.unknown().optional(),
});

const numericish = z.union([z.number(), z.string()]);

const lineDataSchema = z
  .object({
    id: numericish.optional(),
    line_id: numericish.optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    exp_date: numericish.optional(),
    package_id: numericish.optional(),
    max_connections: numericish.optional(),
    is_trial: z.union([z.number(), z.string(), z.boolean()]).optional(),
    enabled: z.union([z.number(), z.string(), z.boolean()]).optional(),
    admin_enabled: z.union([z.number(), z.string(), z.boolean()]).optional(),
  })
  .passthrough();

const userDataSchema = z
  .object({
    id: numericish,
    username: z.string(),
    credits: numericish.optional(),
    status: numericish.optional(),
  })
  .passthrough();

export type LineStatus = "active" | "blocked" | "expired";

export interface XuiLine {
  id: string;
  username: string;
  password: string;
  expDate: string;
  expDateUnix: number;
  packageId: number;
  status: LineStatus;
  maxConnections: number;
  isTrial: boolean;
}

export interface XuiUser {
  id: string;
  username: string;
  credits: number;
  status: string;
}

export interface XuiLineCreated {
  id: string;
  username: string;
  password: string;
  packageId: number;
  expDate: string;
  expDateUnix: number;
}

function truthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return false;
}

function toIdString(value: unknown, field: string, action: string): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new XuiError(
    `Panel returned a non-numeric ${field}: ${JSON.stringify(value)}`,
    action,
  );
}

function toUnixSeconds(value: unknown, field: string, action: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new XuiError(
      `Panel returned an invalid ${field} (expected a unix timestamp): ${JSON.stringify(value)}`,
      action,
    );
  }
  return Math.trunc(n);
}

function deriveStatus(enabled: unknown, adminEnabled: unknown, expUnix: number): LineStatus {
  if (expUnix * 1000 <= Date.now()) return "expired";
  const userOk = enabled === undefined ? true : truthy(enabled);
  const adminOk = adminEnabled === undefined ? true : truthy(adminEnabled);
  return userOk && adminOk ? "active" : "blocked";
}

/** Builds the request URL with the api_key stripped, for safe logging. */
function redact(target: URL): string {
  const copy = new URL(target.toString());
  copy.searchParams.set("api_key", "[REDACTED]");
  return copy.toString();
}

export async function call(
  action: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const cfg = loadConfig();
  const target = new URL(cfg.url);
  target.searchParams.set("action", action);
  target.searchParams.set("api_key", cfg.apiKey);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

  let res: Response;
  try {
    res = await fetch(target, { method: "GET", signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new XuiError(
        `Request to the panel timed out after ${cfg.requestTimeoutMs}ms. ` +
          `Check XUI_URL is reachable (${redact(target)}) or raise XUI_TIMEOUT_MS.`,
        action,
        err,
      );
    }
    throw new XuiError(
      `Could not reach the panel at ${redact(target)}. Verify XUI_URL and network access.`,
      action,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new XuiError(
      `Panel returned HTTP ${res.status} for action '${action}'. ` +
        `A 404 usually means XUI_URL points at the wrong addon path; ` +
        `note the reseller API base normally needs a trailing slash.`,
      action,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new XuiError(
      `Panel returned a non-JSON body for action '${action}'. ` +
        `This usually means XUI_URL points at the panel UI instead of the reseller API addon.`,
      action,
      err,
    );
  }

  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new XuiError(
      `Unrecognised response envelope for action '${action}': ${JSON.stringify(body).slice(0, 400)}`,
      action,
    );
  }
  if (parsed.data.status !== "STATUS_SUCCESS") {
    throw new XuiError(
      `Panel rejected action '${action}': ${parsed.data.error ?? parsed.data.status}`,
      action,
    );
  }
  return parsed.data.data;
}

function parseLine(data: unknown, action: string, fallbackId?: string): XuiLine {
  const d = lineDataSchema.parse(data);
  const expUnix = toUnixSeconds(d.exp_date, "exp_date", action);
  const rawId = d.id ?? d.line_id;
  return {
    id: rawId !== undefined ? toIdString(rawId, "id", action) : (fallbackId ?? ""),
    username: d.username ?? "",
    password: d.password ?? "",
    expDate: new Date(expUnix * 1000).toISOString(),
    expDateUnix: expUnix,
    packageId: d.package_id !== undefined ? Number(d.package_id) : 0,
    status: deriveStatus(d.enabled, d.admin_enabled, expUnix),
    maxConnections: d.max_connections !== undefined ? Number(d.max_connections) : 0,
    isTrial: truthy(d.is_trial),
  };
}

export async function getLine(id: string): Promise<XuiLine> {
  return parseLine(await call("get_line", { id }), "get_line", id);
}

export async function getUser(id: string): Promise<XuiUser> {
  const d = userDataSchema.parse(await call("get_user", { id }));
  return {
    id: String(d.id),
    username: d.username,
    credits: d.credits != null ? Number(d.credits) : 0,
    status: String(d.status ?? ""),
  };
}

/**
 * Returns the account that owns the API key, not an arbitrary user: the panel
 * ignores any id passed to `user_info`. Its `credits` field is therefore the
 * master credit pool, which is what line creation draws down.
 */
export async function userInfo(): Promise<XuiUser> {
  const d = userDataSchema.parse(await call("user_info"));
  return {
    id: String(d.id),
    username: d.username,
    credits: d.credits != null ? Number(d.credits) : 0,
    status: String(d.status ?? ""),
  };
}

export interface CreateLineOptions {
  packageId: number;
  username: string;
  password: string;
  /** Trial packages bake their own duration in; no separate duration field exists. */
  trial?: boolean;
}

export async function createLine(opts: CreateLineOptions): Promise<XuiLineCreated> {
  const cfg = loadConfig();
  const params: Record<string, string> = {
    package: String(opts.packageId),
    username: opts.username,
    password: opts.password,
    server_id: String(cfg.serverId),
  };
  if (opts.trial) params.trial = "1";

  const line = parseLine(await call("create_line", params), "create_line");
  return {
    id: line.id,
    username: opts.username,
    password: opts.password,
    packageId: opts.packageId,
    expDate: line.expDate,
    expDateUnix: line.expDateUnix,
  };
}

export async function editLine(
  id: string,
  packageId: number,
): Promise<{ id: string; expDate: string; expDateUnix: number }> {
  const line = parseLine(
    await call("edit_line", { id, package: String(packageId) }),
    "edit_line",
    id,
  );
  return { id, expDate: line.expDate, expDateUnix: line.expDateUnix };
}

export async function deleteLine(id: string): Promise<void> {
  await call("delete_line", { id });
}

/**
 * Tops up a sub-reseller's credits. The panel does not consistently echo the
 * resulting balance, so `null` means "accepted, balance unknown" rather than
 * failure — callers should re-read with `get_user` if they need the number.
 */
export async function addResellerCredits(
  resellerId: string,
  credits: number,
): Promise<number | null> {
  const data = await call("add_reseller_credits", {
    id: resellerId,
    credits: String(credits),
  });
  const parsed = z
    .object({ credits: numericish.optional() })
    .passthrough()
    .safeParse(data);
  if (!parsed.success || parsed.data.credits === undefined) return null;
  const value = Number(parsed.data.credits);
  return Number.isFinite(value) ? value : null;
}
