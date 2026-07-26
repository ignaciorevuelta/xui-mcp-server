/**
 * The provisioning commands run as root on a remote machine, so anything
 * caller-supplied that reaches them is a potential command injection. Only the
 * SSH public key does, and these tests pin that down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";

/** Captures the commands install() would run instead of connecting anywhere. */
const captured: { label: string; command: string }[] = [];

vi.mock("../src/ssh.js", () => ({
  runScript: async (_target: unknown, steps: { label: string; command: string }[]) => {
    captured.push(...steps);
    return steps.map((s) => ({ label: s.label, result: { code: 0, stdout: "", stderr: "" } }));
  },
  run: async () => ({ code: 0, stdout: "", stderr: "" }),
  assertProvisioningAllowed: () => undefined,
}));

const { install } = await import("../src/provision.js");

const VALID_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOORzslKqnx2fw8eYt7 user@host";

beforeEach(() => {
  captured.length = 0;
  resetConfigCache();
  vi.stubEnv("XUI_URL", "http://panel.test/api/");
  vi.stubEnv("XUI_API_KEY", "k");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfigCache();
});

describe("ssh key installation", () => {
  it("never puts the key itself into the shell command", async () => {
    await install({ host: "h" }, { hardenSsh: true, publicKey: VALID_KEY });
    const step = captured.find((s) => s.label.includes("ssh key"));
    expect(step).toBeDefined();
    // The literal key must not appear; it travels base64-encoded.
    expect(step!.command).not.toContain("AAAAC3NzaC1lZDI1NTE5");
    expect(step!.command).toContain("base64 -d");
  });

  it("round-trips the key through base64 unchanged", async () => {
    await install({ host: "h" }, { hardenSsh: true, publicKey: VALID_KEY });
    const step = captured.find((s) => s.label.includes("ssh key"))!;
    const encoded = /printf %s '([A-Za-z0-9+/=]+)'/.exec(step.command)?.[1];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(VALID_KEY);
  });

  it.each([
    ["single quote breaking out of the literal", "ssh-rsa AAAB' ; rm -rf / ; echo '"],
    ["command substitution", "ssh-rsa AAAB$(id)"],
    ["backtick substitution", "ssh-rsa AAAB`id`"],
    ["newline injecting a second command", "ssh-rsa AAAB\nrm -rf /"],
    ["not a key at all", "hello world"],
    ["unsupported key type", "ssh-dsa2 AAAB"],
  ])("rejects %s", async (_name, key) => {
    await expect(install({ host: "h" }, { hardenSsh: true, publicKey: key })).rejects.toThrow(
      /valid OpenSSH public key/,
    );
    expect(captured.find((s) => s.label.includes("ssh key"))).toBeUndefined();
  });

  it("skips the step entirely when hardening is off", async () => {
    await install({ host: "h" }, { hardenSsh: false });
    expect(captured.find((s) => s.label.includes("ssh key"))).toBeUndefined();
  });
});

describe("install command set", () => {
  it("verifies both downloaded artefacts by hash", async () => {
    await install({ host: "h" }, { hardenSsh: false });
    const payload = captured.find((s) => s.label.includes("payload"))!;
    const patch = captured.find((s) => s.label.includes("licence"))!;
    expect(payload.command).toContain("HASH MISMATCH");
    expect(payload.command).toContain("exit 1");
    expect(patch.command).toContain("PATCH HASH MISMATCH");
    expect(patch.command).toContain("exit 1");
  });

  it("stops the run if the payload cannot be verified", async () => {
    await install({ host: "h" }, { hardenSsh: false });
    const payload = captured.find((s) => s.label.includes("payload"));
    expect((payload as { stopOnError?: boolean }).stopOnError).toBe(true);
  });

  it("does not echo panel credentials back to the caller", async () => {
    await install({ host: "h" }, { hardenSsh: false });
    const panel = captured.find((s) => s.label === "install panel")!;
    expect(panel.command).toContain("[stored on server]");
  });
});
