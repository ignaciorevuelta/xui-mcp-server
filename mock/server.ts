/**
 * Mock XUI.ONE reseller API.
 *
 * Reproduces the panel's request/response contract closely enough to develop
 * and test the MCP server against, without touching a live panel holding real
 * customer subscriptions. Response shapes were taken from observed production
 * traffic, including the panel's habit of returning numbers as strings.
 *
 * Run with:  npm run mock
 * Then point the MCP server at it:
 *   XUI_URL=http://127.0.0.1:8899/  XUI_API_KEY=test-key
 */

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8899);
const API_KEY = process.env.MOCK_API_KEY ?? "test-key";

interface Line {
  id: number;
  username: string;
  password: string;
  exp_date: number;
  package_id: number;
  max_connections: number;
  is_trial: number;
  enabled: number;
  admin_enabled: number;
}

interface User {
  id: number;
  username: string;
  credits: number;
  status: string;
}

/** Package id -> duration in seconds. Mirrors how the real panel bakes duration into packages. */
const PACKAGE_DURATIONS: Record<number, number> = {
  82: 5 * 3600, // trial 5h
  54: 24 * 3600, // trial 24h
  114: 30 * 86400,
  134: 365 * 86400,
};

const now = () => Math.floor(Date.now() / 1000);

let nextLineId = 1_600_000;
const lines = new Map<number, Line>();
const users = new Map<number, User>([
  [3012, { id: 3012, username: "owner", credits: 88, status: "Active" }],
  [4821, { id: 4821, username: "subreseller", credits: 12, status: "Active" }],
]);

// One expired and one active line so tests can exercise both status paths.
lines.set(1_612_073, {
  id: 1_612_073,
  username: "demo_active",
  password: "pw_active",
  exp_date: now() + 90 * 86400,
  package_id: 134,
  max_connections: 3,
  is_trial: 0,
  enabled: 1,
  admin_enabled: 1,
});
lines.set(1_735_171, {
  id: 1_735_171,
  username: "demo_expired",
  password: "pw_expired",
  exp_date: now() - 86400,
  package_id: 114,
  max_connections: 1,
  is_trial: 0,
  enabled: 1,
  admin_enabled: 1,
});

function ok(data?: unknown): string {
  return JSON.stringify(data === undefined ? { status: "STATUS_SUCCESS" } : { status: "STATUS_SUCCESS", data });
}

function fail(error: string): string {
  return JSON.stringify({ status: "STATUS_FAILURE", error });
}

/** The real panel serialises most numerics as strings; mirror that faithfully. */
function serialiseLine(line: Line): Record<string, string | number> {
  return {
    id: String(line.id),
    username: line.username,
    password: line.password,
    exp_date: String(line.exp_date),
    package_id: String(line.package_id),
    max_connections: String(line.max_connections),
    is_trial: String(line.is_trial),
    enabled: String(line.enabled),
    admin_enabled: String(line.admin_enabled),
  };
}

function handle(action: string, q: URLSearchParams): string {
  switch (action) {
    case "user_info": {
      // The panel ignores any id and always answers for the key owner.
      const owner = users.get(3012)!;
      return ok({ id: String(owner.id), username: owner.username, credits: String(owner.credits), status: owner.status });
    }

    case "get_user": {
      const user = users.get(Number(q.get("id")));
      if (!user) return fail("User not found.");
      return ok({ id: String(user.id), username: user.username, credits: String(user.credits), status: user.status });
    }

    case "get_line": {
      const line = lines.get(Number(q.get("id")));
      if (!line) return fail("Line not found.");
      return ok(serialiseLine(line));
    }

    case "create_line": {
      const pkg = Number(q.get("package"));
      const duration = PACKAGE_DURATIONS[pkg];
      if (duration === undefined) return fail("Invalid package.");
      const username = q.get("username") ?? `auto${nextLineId}`;
      if ([...lines.values()].some((l) => l.username === username)) {
        return fail("Username already exists.");
      }
      const owner = users.get(3012)!;
      if (owner.credits <= 0) return fail("Not enough credits.");
      owner.credits -= 1;

      const line: Line = {
        id: nextLineId++,
        username,
        password: q.get("password") ?? "generated",
        exp_date: now() + duration,
        package_id: pkg,
        max_connections: 1,
        is_trial: q.get("trial") === "1" ? 1 : 0,
        enabled: 1,
        admin_enabled: 1,
      };
      lines.set(line.id, line);
      return ok(serialiseLine(line));
    }

    case "edit_line": {
      const line = lines.get(Number(q.get("id")));
      if (!line) return fail("Line not found.");
      const pkg = Number(q.get("package"));
      const duration = PACKAGE_DURATIONS[pkg];
      if (duration === undefined) return fail("Invalid package.");
      // Renewing an expired line restarts from now, matching panel behaviour.
      const base = Math.max(line.exp_date, now());
      line.exp_date = base + duration;
      line.package_id = pkg;
      return ok(serialiseLine(line));
    }

    case "delete_line": {
      const id = Number(q.get("id"));
      if (!lines.delete(id)) return fail("Line not found.");
      return ok(); // status-only response, no data key
    }

    case "add_reseller_credits": {
      const user = users.get(Number(q.get("id")));
      if (!user) return fail("User not found.");
      const credits = Number(q.get("credits"));
      if (!Number.isInteger(credits) || credits <= 0) return fail("Invalid credits.");
      user.credits += credits;
      return ok({ credits: String(user.credits) });
    }

    default:
      return fail("Invalid action.");
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const q = url.searchParams;
  res.setHeader("Content-Type", "application/json");

  if (q.get("api_key") !== API_KEY) {
    res.end(fail("Invalid API key."));
    return;
  }
  const action = q.get("action");
  if (!action) {
    res.end(fail("No action specified."));
    return;
  }
  res.end(handle(action, q));
}).listen(PORT, "127.0.0.1", () => {
  console.error(`mock XUI reseller API on http://127.0.0.1:${PORT}/ (api_key=${API_KEY})`);
});
