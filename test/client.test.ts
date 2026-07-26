/**
 * Unit tests for the XUI client's response handling.
 *
 * The panel's serialisation is inconsistent — the same field arrives as a
 * number in one action and a numeric string in another — so the coercion and
 * error paths are where this integration actually breaks. `fetch` is stubbed
 * so these run without a panel or the mock server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import {
  XuiError,
  addResellerCredits,
  createLine,
  deleteLine,
  editLine,
  getLine,
  userInfo,
} from "../src/client.js";

const BASE_ENV = {
  XUI_URL: "http://panel.test:8880/Addon/",
  XUI_API_KEY: "secret-key",
  XUI_SERVER_ID: "1",
};

function stubResponse(body: unknown, init: { ok?: boolean; status?: number; raw?: string } = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => {
      if (init.raw !== undefined) throw new SyntaxError("Unexpected token <");
      return body;
    },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const success = (data?: unknown) =>
  data === undefined ? { status: "STATUS_SUCCESS" } : { status: "STATUS_SUCCESS", data };

/** Far enough out that the test never races the clock. */
const FUTURE = Math.floor(Date.now() / 1000) + 90 * 86400;
const PAST = Math.floor(Date.now() / 1000) - 86400;

beforeEach(() => {
  resetConfigCache();
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetConfigCache();
});

describe("request construction", () => {
  it("sends action and api_key as query params on the configured base", async () => {
    const fetchMock = stubResponse(
      success({ id: "1", exp_date: String(FUTURE), package_id: "134" }),
    );
    await getLine("1612073");

    const url = fetchMock.mock.calls[0]![0] as URL;
    expect(url.origin + url.pathname).toBe("http://panel.test:8880/Addon/");
    expect(url.searchParams.get("action")).toBe("get_line");
    expect(url.searchParams.get("api_key")).toBe("secret-key");
    expect(url.searchParams.get("id")).toBe("1612073");
  });

  it("sends the configured server_id when creating a line", async () => {
    vi.stubEnv("XUI_SERVER_ID", "7");
    resetConfigCache();
    const fetchMock = stubResponse(success({ id: 900, exp_date: FUTURE }));

    await createLine({ packageId: 134, username: "u", password: "p" });

    const url = fetchMock.mock.calls[0]![0] as URL;
    expect(url.searchParams.get("server_id")).toBe("7");
    expect(url.searchParams.get("trial")).toBeNull();
  });

  it("marks trial creation with trial=1", async () => {
    const fetchMock = stubResponse(success({ id: 901, exp_date: FUTURE }));
    await createLine({ packageId: 82, username: "u", password: "p", trial: true });
    expect((fetchMock.mock.calls[0]![0] as URL).searchParams.get("trial")).toBe("1");
  });
});

describe("numeric coercion", () => {
  it("accepts string-serialised numerics", async () => {
    stubResponse(
      success({
        id: "1612073",
        username: "carlos",
        password: "pw",
        exp_date: String(FUTURE),
        package_id: "134",
        max_connections: "3",
        is_trial: "0",
      }),
    );
    const line = await getLine("1612073");

    expect(line.id).toBe("1612073");
    expect(line.packageId).toBe(134);
    expect(line.maxConnections).toBe(3);
    expect(line.isTrial).toBe(false);
    expect(line.expDateUnix).toBe(FUTURE);
    expect(line.expDate).toBe(new Date(FUTURE * 1000).toISOString());
  });

  it("accepts real numbers for the same fields", async () => {
    stubResponse(success({ id: 1612073, exp_date: FUTURE, package_id: 134, is_trial: 1 }));
    const line = await getLine("1612073");
    expect(line.packageId).toBe(134);
    expect(line.isTrial).toBe(true);
  });

  it("falls back to line_id when id is absent on creation", async () => {
    stubResponse(success({ line_id: "2105540", exp_date: FUTURE }));
    const created = await createLine({ packageId: 134, username: "u", password: "p" });
    expect(created.id).toBe("2105540");
  });

  it("rejects a non-numeric exp_date rather than inventing a date", async () => {
    stubResponse(success({ id: "1", exp_date: "never" }));
    await expect(getLine("1")).rejects.toThrow(/exp_date/);
  });

  it("rejects a missing exp_date", async () => {
    stubResponse(success({ id: "1" }));
    await expect(getLine("1")).rejects.toBeInstanceOf(XuiError);
  });
});

describe("line status derivation", () => {
  it("is active when enabled and not expired", async () => {
    stubResponse(success({ id: "1", exp_date: FUTURE, enabled: "1", admin_enabled: "1" }));
    expect((await getLine("1")).status).toBe("active");
  });

  it("is expired when past exp_date regardless of enabled flags", async () => {
    stubResponse(success({ id: "1", exp_date: PAST, enabled: "1", admin_enabled: "1" }));
    expect((await getLine("1")).status).toBe("expired");
  });

  it("is blocked when the admin disabled it", async () => {
    stubResponse(success({ id: "1", exp_date: FUTURE, enabled: "1", admin_enabled: "0" }));
    expect((await getLine("1")).status).toBe("blocked");
  });

  it("is blocked when the user flag is off", async () => {
    stubResponse(success({ id: "1", exp_date: FUTURE, enabled: 0, admin_enabled: 1 }));
    expect((await getLine("1")).status).toBe("blocked");
  });

  it("assumes enabled when the panel omits the flags", async () => {
    stubResponse(success({ id: "1", exp_date: FUTURE }));
    expect((await getLine("1")).status).toBe("active");
  });
});

describe("error handling", () => {
  it("surfaces the panel's own error text", async () => {
    stubResponse({ status: "STATUS_FAILURE", error: "Invalid API key." });
    await expect(getLine("1")).rejects.toThrow(/Invalid API key/);
  });

  it("does not leak the api_key in connection errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(getLine("1")).rejects.toThrow(/REDACTED/);
    await expect(getLine("1")).rejects.not.toThrow(/secret-key/);
  });

  it("explains a non-JSON body as a likely wrong URL", async () => {
    stubResponse(undefined, { raw: "<html>" });
    await expect(getLine("1")).rejects.toThrow(/reseller API addon/);
  });

  it("explains an HTTP error and hints at the trailing slash", async () => {
    stubResponse({}, { ok: false, status: 404 });
    await expect(getLine("1")).rejects.toThrow(/trailing slash/);
  });
});

describe("actions with unusual response shapes", () => {
  it("tolerates delete_line returning no data key", async () => {
    stubResponse(success());
    await expect(deleteLine("1612073")).resolves.toBeUndefined();
  });

  it("returns the new expiry from edit_line", async () => {
    stubResponse(success({ id: "1", exp_date: String(FUTURE) }));
    const edited = await editLine("1612073", 134);
    expect(edited.id).toBe("1612073");
    expect(edited.expDateUnix).toBe(FUTURE);
  });

  it("returns null when add_reseller_credits does not echo a balance", async () => {
    stubResponse(success({ ok: true }));
    await expect(addResellerCredits("4821", 100)).resolves.toBeNull();
  });

  it("returns the echoed balance when the panel provides one", async () => {
    stubResponse(success({ credits: "112" }));
    await expect(addResellerCredits("4821", 100)).resolves.toBe(112);
  });

  it("reads the key owner's credit pool from user_info", async () => {
    stubResponse(success({ id: "3012", username: "Galaxytv", credits: "88" }));
    const owner = await userInfo();
    expect(owner.id).toBe("3012");
    expect(owner.credits).toBe(88);
  });
});

describe("configuration", () => {
  it("fails fast and names every missing variable", async () => {
    vi.unstubAllEnvs();
    resetConfigCache();
    await expect(getLine("1")).rejects.toThrow(/XUI_URL.*XUI_API_KEY|XUI_API_KEY/);
  });

  it("rejects a malformed XUI_URL", async () => {
    vi.stubEnv("XUI_URL", "not-a-url");
    resetConfigCache();
    await expect(getLine("1")).rejects.toThrow(/not a valid URL/);
  });
});
