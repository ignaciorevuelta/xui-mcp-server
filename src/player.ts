/**
 * XUI.ONE Player API client.
 *
 * This is the surface end-user apps call, and it authenticates differently from
 * the other two: a line's own username and password, no API key and no access
 * code. That makes it the only way to answer "does this customer's line
 * actually work?" from the customer's side rather than the panel's.
 *
 * It lives at `player_api.php` on the panel root, so its base is the origin of
 * the reseller URL unless XUI_PLAYER_URL overrides it.
 */

import { z } from "zod";
import { loadConfig } from "./config.js";
import { XuiError } from "./client.js";

/** Catalogue reads. All return a bare JSON array. */
export const CATALOG_ACTIONS = [
  "get_live_categories",
  "get_live_streams",
  "get_vod_categories",
  "get_vod_streams",
  "get_series_categories",
  "get_series",
] as const;

export type CatalogAction = (typeof CATALOG_ACTIONS)[number];

export interface LineCredentials {
  username: string;
  password: string;
}

export interface PlayerAuth {
  authenticated: boolean;
  username: string;
  status: string;
  message: string;
  expiresAt: string | null;
  expiresAtUnix: number | null;
  isTrial: boolean;
  activeConnections: number;
  maxConnections: number;
  allowedOutputFormats: string[];
  serverUrl: string;
  serverPort: string;
  httpsPort: string;
  panelVersion: string;
}

const userInfoSchema = z
  .object({
    username: z.string().optional(),
    message: z.string().optional(),
    auth: z.union([z.number(), z.string()]).optional(),
    status: z.string().optional(),
    exp_date: z.union([z.number(), z.string()]).nullable().optional(),
    is_trial: z.union([z.number(), z.string()]).optional(),
    active_cons: z.union([z.number(), z.string()]).optional(),
    max_connections: z.union([z.number(), z.string()]).optional(),
    allowed_output_formats: z.array(z.string()).optional(),
  })
  .passthrough();

const serverInfoSchema = z
  .object({
    url: z.string().optional(),
    port: z.union([z.number(), z.string()]).optional(),
    https_port: z.union([z.number(), z.string()]).optional(),
    version: z.string().optional(),
  })
  .passthrough();

/** Player base: explicit override, else the origin of the reseller URL. */
function playerUrl(): string {
  const cfg = loadConfig();
  if (cfg.playerUrl) return cfg.playerUrl;
  try {
    return `${new URL(cfg.url).origin}/player_api.php`;
  } catch {
    throw new XuiError(
      "Could not derive the Player API URL from XUI_URL. Set XUI_PLAYER_URL explicitly, " +
        "e.g. https://panel.example.com/player_api.php",
      "player",
    );
  }
}

async function call(
  creds: LineCredentials,
  params: Record<string, string> = {},
): Promise<unknown> {
  const cfg = loadConfig();
  const target = new URL(playerUrl());
  target.searchParams.set("username", creds.username);
  target.searchParams.set("password", creds.password);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

  let res: Response;
  try {
    res = await fetch(target, { method: "GET", signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new XuiError(`Player API request timed out after ${cfg.requestTimeoutMs}ms.`, "player", err);
    }
    // The URL carries the line's password; report the host only.
    throw new XuiError(`Could not reach the Player API at ${target.origin}.`, "player", err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new XuiError(
      `Player API returned HTTP ${res.status}. A 404 here usually means XUI_PLAYER_URL points ` +
        `somewhere other than the panel root — it should end in /player_api.php.`,
      "player",
    );
  }

  try {
    return await res.json();
  } catch (err) {
    throw new XuiError(
      "Player API returned a non-JSON body. Check XUI_PLAYER_URL points at player_api.php.",
      "player",
      err,
    );
  }
}

function truthy(v: unknown): boolean {
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
  return v === true;
}

export async function authenticate(creds: LineCredentials): Promise<PlayerAuth> {
  const body = await call(creds);
  const parsed = z
    .object({ user_info: userInfoSchema.optional(), server_info: serverInfoSchema.optional() })
    .passthrough()
    .safeParse(body);

  if (!parsed.success || !parsed.data.user_info) {
    throw new XuiError(
      `Player API did not return user_info: ${JSON.stringify(body).slice(0, 200)}`,
      "player",
    );
  }

  const u = parsed.data.user_info;
  const s = parsed.data.server_info ?? {};
  const expUnix = u.exp_date != null && u.exp_date !== "" ? Number(u.exp_date) : null;

  return {
    authenticated: truthy(u.auth),
    username: u.username ?? creds.username,
    status: u.status ?? "",
    message: u.message ?? "",
    expiresAt: expUnix && Number.isFinite(expUnix) ? new Date(expUnix * 1000).toISOString() : null,
    expiresAtUnix: expUnix && Number.isFinite(expUnix) ? expUnix : null,
    isTrial: truthy(u.is_trial),
    activeConnections: Number(u.active_cons ?? 0) || 0,
    maxConnections: Number(u.max_connections ?? 0) || 0,
    allowedOutputFormats: u.allowed_output_formats ?? [],
    serverUrl: s.url ?? "",
    serverPort: String(s.port ?? ""),
    httpsPort: String(s.https_port ?? ""),
    panelVersion: s.version ?? "",
  };
}

/** Catalogue reads always return an array; anything else means the line was rejected. */
export async function catalog(
  creds: LineCredentials,
  action: CatalogAction,
  categoryId?: string,
): Promise<unknown[]> {
  const params: Record<string, string> = { action };
  if (categoryId) params.category_id = categoryId;
  const body = await call(creds, params);
  if (!Array.isArray(body)) {
    throw new XuiError(
      `Player API returned no list for '${action}'. The line is usually rejected, expired or ` +
        `has no bouquet assigned. Verify with the auth tool first.`,
      "player",
    );
  }
  return body;
}

export async function shortEpg(
  creds: LineCredentials,
  streamId: string,
  limit: number,
): Promise<unknown[]> {
  const body = await call(creds, {
    action: "get_short_epg",
    stream_id: streamId,
    limit: String(limit),
  });
  const parsed = z.object({ epg_listings: z.array(z.unknown()).optional() }).passthrough().safeParse(body);
  return parsed.success ? (parsed.data.epg_listings ?? []) : [];
}
