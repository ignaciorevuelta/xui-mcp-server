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
  // Distinctive on purpose: a short value like "k" appears by chance in almost
  // any shell command and would make the leak assertion below meaningless.
  vi.stubEnv("XUI_API_KEY", "zzUNIQUEAPIKEY9c1fzz");
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
    ["not a key at all", "hello world"],
    ["unsupported key type", "ssh-dsa2 AAAB"],
  ])("rejects %s", async (_name, key) => {
    await expect(install({ host: "h" }, { hardenSsh: true, publicKey: key })).rejects.toThrow();
    expect(captured.find((s) => s.label.includes("ssh key"))).toBeUndefined();
  });

  // Base64 keeps the value away from the shell, but says nothing about a second
  // line: authorized_keys is line-oriented, so a newline would authorise a key
  // the caller never declared.
  it.each([
    ["a trailing second key", `${VALID_KEY}\nssh-rsa AAAAB3NzaC1yc2E attacker@host`],
    ["a carriage return", `${VALID_KEY}\rssh-rsa AAAAB3NzaC1yc2E attacker@host`],
    ["a newline inside the comment", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOORz first\nsecond"],
  ])("rejects %s", async (_name, key) => {
    await expect(install({ host: "h" }, { hardenSsh: true, publicKey: key })).rejects.toThrow(
      /single line/,
    );
    expect(captured.find((s) => s.label.includes("ssh key"))).toBeUndefined();
  });

  it("rejects a key whose body does not match its declared type", async () => {
    // Well-formed base64, correct shape, but the blob encodes ssh-rsa.
    const spliced = "ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAAB";
    await expect(install({ host: "h" }, { hardenSsh: true, publicKey: spliced })).rejects.toThrow(
      /declares ssh-ed25519/,
    );
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
    // The command must not print the credentials file, only acknowledge it.
    expect(panel.command).not.toMatch(/cat\s+.*credentials\.txt/);
  });

  it("keeps configured secrets out of every generated command", async () => {
    await install({ host: "h" }, { hardenSsh: false });
    for (const step of captured) {
      expect(step.command).not.toContain(process.env.XUI_API_KEY);
    }
  });
});
