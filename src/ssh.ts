/**
 * Minimal SSH execution layer for the provisioning tools.
 *
 * This is the only part of the server that runs commands on another machine,
 * and it runs them as root. Everything here is written on the assumption that
 * it will one day be pointed at the wrong host by accident: connections are
 * refused unless provisioning is explicitly enabled, hosts must be on an
 * allowlist when one is configured, and credentials never appear in returned
 * output or errors.
 */

import { Client } from "ssh2";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { XuiError } from "./client.js";

export interface SshTarget {
  host: string;
  port?: number;
  username?: string;
  /** Path to a private key. Preferred over a password. */
  privateKeyPath?: string;
  password?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Throws unless provisioning is enabled and the host is permitted. Called
 * before every connection, not once at startup, so a mid-session config change
 * cannot leave a stale permission.
 */
export function assertProvisioningAllowed(host: string): void {
  const cfg = loadConfig();
  if (!cfg.allowProvisioning) {
    throw new XuiError(
      "Server provisioning is turned off (XUI_ALLOW_PROVISIONING=false). Remove that " +
        "setting, or set it to true, to allow this server to open root SSH sessions again.",
      "provision",
    );
  }
  const allow = cfg.provisionHosts;
  if (allow.length > 0 && !allow.includes(host)) {
    throw new XuiError(
      `Host ${host} is not in XUI_PROVISION_HOSTS. Permitted: ${allow.join(", ")}. ` +
        `Add it there if this is intentional.`,
      "provision",
    );
  }
}

function connect(target: SshTarget, timeoutMs: number): Promise<Client> {
  assertProvisioningAllowed(target.host);

  if (!target.privateKeyPath && !target.password) {
    throw new XuiError(
      `No credentials for ${target.host}: supply private_key_path (preferred) or password.`,
      "provision",
    );
  }

  let privateKey: Buffer | undefined;
  if (target.privateKeyPath) {
    try {
      privateKey = readFileSync(target.privateKeyPath);
    } catch (err) {
      throw new XuiError(
        `Could not read the private key at ${target.privateKeyPath}.`,
        "provision",
        err,
      );
    }
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new XuiError(`SSH connection to ${target.host} timed out.`, "provision"));
    }, timeoutMs);

    conn
      .on("ready", () => {
        clearTimeout(timer);
        resolve(conn);
      })
      .on("error", (err) => {
        clearTimeout(timer);
        // ssh2 puts the attempted credentials in some error paths; report only the reason.
        reject(
          new XuiError(
            `SSH to ${target.username ?? "root"}@${target.host} failed: ${err.message}`,
            "provision",
          ),
        );
      })
      .connect({
        host: target.host,
        port: target.port ?? 22,
        username: target.username ?? "root",
        ...(privateKey ? { privateKey } : {}),
        ...(target.password ? { password: target.password } : {}),
        readyTimeout: timeoutMs,
      });
  });
}

/** Runs one command and collects its output. Never throws on a non-zero exit. */
function execOn(conn: Client, command: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(new XuiError(`Could not start command: ${err.message}`, "provision"));
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        stream.close();
        resolve({ code: 124, stdout, stderr: stderr + `\n[timed out after ${timeoutMs}ms]` });
      }, timeoutMs);

      stream
        .on("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ code: code ?? 0, stdout, stderr });
        })
        .on("data", (d: Buffer) => {
          stdout += d.toString();
        })
        .stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
    });
  });
}

/**
 * Opens one connection, runs the given commands in order, and closes it.
 * Stops early if a command fails and `stopOnError` is set, so a failed
 * precondition does not cascade into a half-finished install.
 */
export async function runScript(
  target: SshTarget,
  commands: { label: string; command: string; timeoutMs?: number; stopOnError?: boolean }[],
  defaultTimeoutMs = 600_000,
): Promise<{ label: string; result: ExecResult }[]> {
  const conn = await connect(target, 30_000);
  const out: { label: string; result: ExecResult }[] = [];
  try {
    for (const step of commands) {
      const result = await execOn(conn, step.command, step.timeoutMs ?? defaultTimeoutMs);
      out.push({ label: step.label, result });
      if (result.code !== 0 && step.stopOnError) break;
    }
  } finally {
    conn.end();
  }
  return out;
}

/** Convenience for a single command. */
export async function run(
  target: SshTarget,
  command: string,
  timeoutMs = 120_000,
): Promise<ExecResult> {
  const [only] = await runScript(target, [{ label: "cmd", command, timeoutMs }]);
  return only!.result;
}
