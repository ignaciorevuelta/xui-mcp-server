/**
 * XUI.ONE Admin API client.
 *
 * Same `?action=…&api_key=…` convention as the reseller API but on a different
 * access code, exposing the panel's full management surface (~60 actions).
 * HMAC headers are an alternative the panel accepts, not a requirement — a
 * plain key works, which is what this client uses.
 *
 * Response shapes are inconsistent: most actions return the usual
 * `{status, data}` envelope, some (`get_bouquets`, `get_categories`,
 * `get_packages`, `get_providers`, `get_servers`) return a bare JSON array,
 * and list endpoints may add DataTables-style `recordsTotal`. `adminCall`
 * normalises all three.
 */

import { z } from "zod";
import { loadConfig } from "./config.js";
import { XuiError } from "./client.js";

/** Read-only actions that return a collection. */
export const LIST_ACTIONS = [
  "get_users",
  "get_lines",
  "get_streams",
  "get_channels",
  "get_movies",
  "get_series_list",
  "get_episodes",
  "get_bouquets",
  "get_categories",
  "get_packages",
  "get_servers",
  "get_providers",
  "get_access_codes",
  "get_epgs",
  "get_hmacs",
] as const;

/** Read-only diagnostic feeds. Useful when debugging an integration. */
export const LOG_ACTIONS = [
  "activity_logs",
  "live_connections",
  "credit_logs",
  "client_logs",
  "user_logs",
  "stream_errors",
  "watch_output",
  "system_logs",
  "login_logs",
  "restream_logs",
  "mag_events",
] as const;

/** Lifecycle actions on a line. `ban` also blocks the line's last IP. */
export const LINE_STATE_ACTIONS = ["enable_line", "disable_line", "ban_line", "unban_line"] as const;

export type ListAction = (typeof LIST_ACTIONS)[number];
export type LogAction = (typeof LOG_ACTIONS)[number];
export type LineStateAction = (typeof LINE_STATE_ACTIONS)[number];

export interface AdminResult {
  /** Rows when the action returned a collection, otherwise null. */
  items: unknown[] | null;
  /** Whatever sat under `data` for non-collection responses. */
  data: unknown;
  /** Server-reported total when the action provides one. */
  total?: number;
}

const envelope = z.object({
  status: z.string(),
  error: z.string().optional(),
  data: z.unknown().optional(),
  recordsTotal: z.union([z.number(), z.string()]).optional(),
});

function adminConfig(): { url: string; apiKey: string; timeoutMs: number } {
  const cfg = loadConfig();
  if (!cfg.adminUrl || !cfg.adminApiKey) {
    throw new XuiError(
      "The Admin API is not configured. Set XUI_ADMIN_URL to an access code of type " +
        "'Admin API' (e.g. https://panel.example/<code>/) and XUI_ADMIN_API_KEY to the " +
        "api_key of an administrator account. It is a different access code and a " +
        "different key from the reseller pair.",
      "admin",
    );
  }
  return { url: cfg.adminUrl, apiKey: cfg.adminApiKey, timeoutMs: cfg.requestTimeoutMs };
}

function redact(target: URL): string {
  const copy = new URL(target.toString());
  copy.searchParams.set("api_key", "[REDACTED]");
  return copy.toString();
}

export async function adminCall(
  action: string,
  params: Record<string, string> = {},
): Promise<AdminResult> {
  const { url, apiKey, timeoutMs } = adminConfig();
  const target = new URL(url);
  target.searchParams.set("action", action);
  target.searchParams.set("api_key", apiKey);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(target, { method: "GET", signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new XuiError(
        `Admin request '${action}' timed out after ${timeoutMs}ms. Raise XUI_TIMEOUT_MS or check XUI_ADMIN_URL.`,
        action,
        err,
      );
    }
    throw new XuiError(`Could not reach the Admin API at ${redact(target)}.`, action, err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new XuiError(
      `Admin API returned HTTP ${res.status} for '${action}'. A 404 usually means ` +
        `XUI_ADMIN_URL points at the wrong access code — it must be one whose type is 'Admin API'.`,
      action,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new XuiError(
      `Admin API returned a non-JSON body for '${action}'. Check XUI_ADMIN_URL points at the API access code, not the admin UI.`,
      action,
      err,
    );
  }

  // Bare array: a handful of list actions answer this way.
  if (Array.isArray(body)) return { items: body, data: body, total: body.length };

  const parsed = envelope.safeParse(body);
  if (!parsed.success) {
    throw new XuiError(
      `Unrecognised admin response for '${action}': ${JSON.stringify(body).slice(0, 300)}`,
      action,
    );
  }
  if (parsed.data.status !== "STATUS_SUCCESS") {
    throw new XuiError(
      `Panel rejected admin action '${action}': ${parsed.data.error ?? parsed.data.status}. ` +
        `Actions usually fail this way when a required parameter is missing.`,
      action,
    );
  }

  const data = parsed.data.data;
  const total =
    parsed.data.recordsTotal !== undefined ? Number(parsed.data.recordsTotal) : undefined;
  return {
    items: Array.isArray(data) ? data : null,
    data,
    total: Number.isFinite(total) ? total : Array.isArray(data) ? data.length : undefined,
  };
}

/**
 * The panel ignores `limit`/`offset` on list actions and returns everything,
 * so slicing happens here. Callers still get honest pagination metadata.
 */
export function paginate<T>(
  items: T[],
  limit: number,
  offset: number,
): { page: T[]; total: number; hasMore: boolean; nextOffset?: number } {
  const page = items.slice(offset, offset + limit);
  const consumed = offset + page.length;
  const hasMore = consumed < items.length;
  return { page, total: items.length, hasMore, ...(hasMore ? { nextOffset: consumed } : {}) };
}
