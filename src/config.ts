/**
 * Runtime configuration, read once from the environment at startup.
 *
 * The panel this server talks to is a live production system holding real
 * customer lines, so mutating actions are opt-in rather than opt-out:
 * `XUI_ALLOW_WRITES` gates creation/modification and `XUI_ALLOW_DELETE`
 * gates line deletion on top of that. A misfired tool call from a model
 * should not be able to cancel somebody's subscription.
 */

export interface XuiConfig {
  /** Reseller API base, e.g. `http://panel.example:8880/MyAddon/` (trailing slash matters). */
  url: string;
  apiKey: string;
  /** `server_id` sent on line creation. Panels with a single streamer use 1. */
  serverId: number;
  requestTimeoutMs: number;
  allowWrites: boolean;
  allowDelete: boolean;
  /**
   * Admin API base and key. A different access code and a different user's key
   * from the reseller pair above, so they are configured separately. Admin
   * tools report a configuration error instead of failing obscurely when unset.
   */
  adminUrl?: string;
  adminApiKey?: string;
  /**
   * Player API base. Optional: it is derived from the origin of `url` when
   * unset, which is right for a normal single-domain panel.
   */
  playerUrl?: string;
  /**
   * Provisioning opens a root SSH session and installs software on a remote
   * machine — a far larger blast radius than the API tools, so it is opt-in
   * and can be pinned to specific hosts.
   */
  allowProvisioning: boolean;
  provisionHosts: string[];
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

let cached: XuiConfig | undefined;

export function loadConfig(): XuiConfig {
  if (cached) return cached;

  const url = process.env.XUI_URL?.trim();
  const apiKey = process.env.XUI_API_KEY?.trim();

  const missing = [
    ...(url ? [] : ["XUI_URL"]),
    ...(apiKey ? [] : ["XUI_API_KEY"]),
  ];
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `XUI_URL is the reseller API base (e.g. http://panel.example:8880/YourAddon/) ` +
        `and XUI_API_KEY is the key issued by the panel.`,
    );
  }

  try {
    new URL(url!);
  } catch {
    throw new Error(`XUI_URL is not a valid URL: ${JSON.stringify(url)}`);
  }

  const adminUrl = process.env.XUI_ADMIN_URL?.trim() || undefined;
  const adminApiKey = process.env.XUI_ADMIN_API_KEY?.trim() || undefined;
  if (adminUrl) {
    try {
      new URL(adminUrl);
    } catch {
      throw new Error(`XUI_ADMIN_URL is not a valid URL: ${JSON.stringify(adminUrl)}`);
    }
  }

  cached = {
    url: url!,
    apiKey: apiKey!,
    serverId: readInt("XUI_SERVER_ID", 1),
    requestTimeoutMs: readInt("XUI_TIMEOUT_MS", 20_000),
    allowWrites: readBool("XUI_ALLOW_WRITES", false),
    allowDelete: readBool("XUI_ALLOW_DELETE", false),
    adminUrl,
    adminApiKey,
    playerUrl: process.env.XUI_PLAYER_URL?.trim() || undefined,
    // On by default: this server is meant to take a machine from bare to working
    // panel, so the tools that do it are available out of the box. Set
    // XUI_ALLOW_PROVISIONING=false to remove remote execution entirely, and
    // XUI_PROVISION_HOSTS to restrict which machines it may touch.
    allowProvisioning: readBool("XUI_ALLOW_PROVISIONING", true),
    provisionHosts: (process.env.XUI_PROVISION_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
  return cached;
}

/** Test seam — drops the memoised config so a new env can be picked up. */
export function resetConfigCache(): void {
  cached = undefined;
}
