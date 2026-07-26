/**
 * Server provisioning for XUI.ONE.
 *
 * Every fix in here was found the hard way on a real install. The comments say
 * why each step exists, because without them the steps look arbitrary and
 * someone will "simplify" them back into a broken panel.
 *
 * XUI.ONE is abandonware: the vendor shut down its licence server and there is
 * no official download. The payload and the licence patch come from community
 * mirrors, and the hashes below were verified byte-identical across two
 * independent sources. Anyone running this is executing unsigned third-party
 * binaries as root on the target machine.
 */

import { run, runScript, type ExecResult, type SshTarget } from "./ssh.js";

/** Release payload: contains xui.tar.gz, database.sql and the vendor installer. */
export const PAYLOAD_URL =
  "https://github.com/amidevous/xui.one/releases/download/test/XUI_1.5.13.zip";
export const PAYLOAD_SHA256 =
  "8e5ffa2a74c64294e6d2b4833d37747f1f57e37de3ca04c760996971524baa64";

/**
 * 2025 licence patch. The older 2022 crack (`xui.so`, 248 KB) leaves the panel
 * reporting `Failed to generate license` and it never stops trying, which is
 * what drives the restart loop. This one reports an expiry in 2038.
 * Byte-identical from xuione/XUIPatch and Stefan2512/XUIPatch-Stefan.
 */
export const PATCH_74_URL =
  "https://github.com/xuione/XUIPatch/raw/refs/heads/main/extension_7.4.so";
export const PATCH_72_URL =
  "https://github.com/xuione/XUIPatch/raw/refs/heads/main/extension_7.2.so";
export const PATCH_74_SHA256 =
  "4a66be7d62ab6cb8c68efe7a3a8e8f0f0456dec5f1ed6323cf837c20a9fc0bc1";

export interface Preflight {
  reachable: boolean;
  os: string;
  arch: string;
  virtualisation: string;
  cpuCores: number;
  memoryMb: number;
  diskFreeGb: number;
  alreadyInstalled: boolean;
  blockers: string[];
  warnings: string[];
}

const PREFLIGHT_CMD = `
echo "OS=$(. /etc/os-release 2>/dev/null; echo "$ID $VERSION_ID")"
echo "ARCH=$(uname -m)"
echo "VIRT=$(systemd-detect-virt 2>/dev/null || echo unknown)"
echo "CORES=$(nproc 2>/dev/null || echo 0)"
echo "MEMMB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}')"
echo "DISKGB=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')"
echo "XUI=$([ -d /home/xui ] && echo yes || echo no)"
echo "OCCUPIED=$(ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | grep -cE ':(80|443|8080)$')"
`;

export async function preflight(target: SshTarget): Promise<Preflight> {
  const res = await run(target, PREFLIGHT_CMD, 60_000);
  const get = (k: string): string =>
    res.stdout.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? "";

  const os = get("OS");
  const arch = get("ARCH");
  const cores = Number(get("CORES")) || 0;
  const memoryMb = Number(get("MEMMB")) || 0;
  const diskFreeGb = Number(get("DISKGB")) || 0;
  const alreadyInstalled = get("XUI") === "yes";
  const occupied = Number(get("OCCUPIED")) || 0;

  const blockers: string[] = [];
  const warnings: string[] = [];

  // XUI ships precompiled x86_64 binaries; there is no ARM build.
  if (arch && arch !== "x86_64") blockers.push(`Architecture ${arch} is unsupported — XUI ships x86_64 binaries only.`);
  // Containers without their own kernel cannot run the panel's networking bits.
  const virt = get("VIRT");
  if (virt === "openvz" || virt === "lxc") blockers.push(`Virtualisation ${virt} is unsupported — KVM or bare metal required.`);
  if (alreadyInstalled) blockers.push("/home/xui already exists — this box already has a panel. Use the repair tool instead.");
  if (occupied > 0) blockers.push(`${occupied} of ports 80/443/8080 are already in use — XUI needs them.`);

  // The panel is linked against OpenSSL 1.1 and libcurl 7.68; 24.04 needs heavy patching.
  if (os && !/ubuntu (20\.04|22\.04)/i.test(os)) warnings.push(`OS is "${os}" — only Ubuntu 20.04 and 22.04 are known-good. 24.04 needs significant patching.`);
  if (memoryMb && memoryMb < 7500) warnings.push(`${memoryMb} MB RAM — 8 GB is the practical minimum.`);
  if (cores && cores < 4) warnings.push(`${cores} CPU cores — 4 is the practical minimum.`);
  if (diskFreeGb && diskFreeGb < 40) warnings.push(`${diskFreeGb} GB free — the payload alone is ~1.3 GB unpacked.`);

  return {
    reachable: res.code === 0 || res.stdout.length > 0,
    os, arch, virtualisation: virt, cpuCores: cores, memoryMb, diskFreeGb,
    alreadyInstalled, blockers, warnings,
  };
}

export interface InstallStep {
  label: string;
  ok: boolean;
  detail: string;
}

function summarise(label: string, r: ExecResult, maxChars = 400): InstallStep {
  const detail = (r.stdout.trim() || r.stderr.trim() || "(no output)").slice(-maxChars);
  return { label, ok: r.code === 0, detail };
}

/**
 * Full install. Long-running: the dependency stage alone compiles PHP and
 * ffmpeg and takes tens of minutes.
 */
export async function install(
  target: SshTarget,
  opts: { hardenSsh: boolean; publicKey?: string },
): Promise<InstallStep[]> {
  const steps: { label: string; command: string; timeoutMs?: number; stopOnError?: boolean }[] = [];

  steps.push({
    label: "system update",
    command: `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl wget unzip xxd ca-certificates >/dev/null 2>&1; echo done`,
    timeoutMs: 900_000,
    stopOnError: true,
  });

  if (opts.hardenSsh && opts.publicKey) {
    // The key is caller-supplied and this command runs as root, so it must not
    // reach the shell as text: a single quote in it would escape the literal and
    // append arbitrary commands. Validate the shape, then move it base64-encoded
    // — that alphabet contains no shell metacharacters.
    if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/]+={0,2}(\s+\S*)?$/.test(opts.publicKey.trim())) {
      throw new Error(
        "public_key is not a valid OpenSSH public key. Expected something like " +
          "'ssh-ed25519 AAAAC3Nza... comment'.",
      );
    }
    const encodedKey = Buffer.from(opts.publicKey.trim(), "utf8").toString("base64");

    // Key first, password auth disabled only after the key is in place.
    steps.push({
      label: "ssh key + disable password auth",
      command: `set -e
mkdir -p /root/.ssh && chmod 700 /root/.ssh
KEY=$(printf %s '${encodedKey}' | base64 -d)
grep -qxF "$KEY" /root/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' "$KEY" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
printf 'PasswordAuthentication no\\nKbdInteractiveAuthentication no\\nPermitRootLogin prohibit-password\\nPubkeyAuthentication yes\\n' > /etc/ssh/sshd_config.d/00-hardening.conf
sshd -t && systemctl restart ssh
sshd -T | grep -E '^(passwordauthentication|permitrootlogin)'`,
      timeoutMs: 60_000,
    });
  }

  steps.push({
    label: "download payload",
    command: `set -e
mkdir -p /root/xui-install && cd /root/xui-install
[ -f XUI_1.5.13.zip ] || curl -sSL --retry 3 -o XUI_1.5.13.zip "${PAYLOAD_URL}"
H=$(sha256sum XUI_1.5.13.zip | cut -d' ' -f1)
[ "$H" = "${PAYLOAD_SHA256}" ] || { echo "HASH MISMATCH: got $H"; exit 1; }
echo "payload verified $H"`,
    timeoutMs: 1_800_000,
    stopOnError: true,
  });

  steps.push({
    label: "dependencies (slow: compiles PHP and ffmpeg)",
    command: `cd /root/xui-install
curl -sSL -o install-dep.sh https://raw.githubusercontent.com/amidevous/xui.one/master/install-dep.sh
export DEBIAN_FRONTEND=noninteractive
bash install-dep.sh > /root/dep.log 2>&1
echo "dependency log: $(wc -l < /root/dep.log) lines"; systemctl is-active mariadb`,
    timeoutMs: 3_600_000,
    stopOnError: true,
  });

  steps.push({
    label: "install panel",
    command: `set -e
cd /root/xui-install
unzip -o -q XUI_1.5.13.zip
curl -sSL -o install.python3 https://raw.githubusercontent.com/amidevous/xui.one/master/install.python3
python3 install.python3 < /dev/null > /root/install.log 2>&1
grep -oE 'http://[^ ]+/[A-Za-z0-9]{8}' /root/install.log | head -1 | sed 's#^#setup url: #'
grep -iE 'MySQL (Username|Password)' /root/xui-install/credentials.txt 2>/dev/null | sed 's/:.*/: [stored on server]/'`,
    timeoutMs: 2_400_000,
    stopOnError: true,
  });

  // /tmp must stay world-writable+sticky: PHP puts its Zend semaphore there and
  // php-fpm dies with "Unable to create lock file" if a tarball has clobbered it.
  steps.push({
    label: "fix /tmp permissions",
    command: `chmod 1777 /tmp; ls -ld /tmp`,
    timeoutMs: 30_000,
  });

  steps.push({
    label: "licence patch (2025)",
    command: `set -e
cd /root/xui-install
E72=/home/xui/bin/php/lib/php/extensions/no-debug-non-zts-20170718
E74=/home/xui/bin/php/lib/php/extensions/no-debug-non-zts-20190902
cp -n $E74/xui.so /root/xui.so.orig.bak 2>/dev/null || true
cp -n /home/xui/config/config.ini /root/config.ini.bak 2>/dev/null || true
curl -sSL -o ext74.so "${PATCH_74_URL}"
H=$(sha256sum ext74.so | cut -d' ' -f1)
[ "$H" = "${PATCH_74_SHA256}" ] || { echo "PATCH HASH MISMATCH: got $H"; exit 1; }
curl -sSL -o ext72.so "${PATCH_72_URL}"
install -o xui -g xui -m 550 ext74.so $E74/xui.so
[ -d $E72 ] && install -o xui -g xui -m 550 ext72.so $E72/xui.so
# The licence must be 16 hex characters; the literal string "cracked" fails validation.
KEY=$(head -c 8 /dev/urandom | xxd -p)
sed -i "s/^license\\s*=.*/license     =   \\"$KEY\\"/" /home/xui/config/config.ini
echo "patch verified $H"`,
    timeoutMs: 300_000,
  });

  // root_signals.php restarts the whole service every minute. That kills any
  // running ffmpeg mid-stream and stops cache_handler.php before it finishes
  // building /home/xui/tmp/cache, which in turn makes auth.php refuse playback.
  steps.push({
    label: "disable the 60-second restart cron",
    command: `[ -f /home/xui/crons/root_signals.php ] && mv /home/xui/crons/root_signals.php /root/root_signals.php.bak && echo "moved to /root/root_signals.php.bak" || echo "already absent"`,
    timeoutMs: 30_000,
  });

  // The default 128000 is about a quarter-second of a 4 Mbit stream — far too
  // little for ffmpeg to identify codecs, so streams fail to start.
  steps.push({
    label: "raise stream probe size",
    command: `mysql -u root xui -e "UPDATE settings SET probesize_ondemand=5000000, stream_max_analyze=10000000;" 2>&1
mysql -u root xui -e "UPDATE streams SET probesize_ondemand=8000000;" 2>&1
echo "probe sizes raised"`,
    timeoutMs: 60_000,
  });

  steps.push({
    label: "firewall",
    command: `ufw allow 22/tcp >/dev/null 2>&1; ufw allow 80/tcp >/dev/null 2>&1; ufw allow 443/tcp >/dev/null 2>&1
ufw allow 8080/tcp >/dev/null 2>&1; ufw allow 8880/tcp >/dev/null 2>&1; ufw allow 25500/tcp >/dev/null 2>&1
ufw --force enable >/dev/null 2>&1
ufw status | head -3`,
    timeoutMs: 120_000,
  });

  steps.push({
    label: "restart and verify",
    command: `systemctl restart xuione; sleep 12
echo "service: $(systemctl is-active xuione)"
echo "nginx workers: $(pgrep -u xui -c nginx)"
echo "php-fpm: $(pgrep -u xui -f php-fpm | wc -l)"
/home/xui/status 2>&1 | sed -n '/^License/,+2p' | tail -1`,
    timeoutMs: 300_000,
  });

  const results = await runScript(target, steps);
  return results.map(({ label, result }) => summarise(label, result));
}

export interface PanelStatus {
  service: string;
  nginxWorkers: number;
  phpFpm: number;
  licence: string;
  restartsLastThreeMin: number;
  cacheLines: number;
  ffmpegRunning: number;
  restartCronPresent: boolean;
  healthy: boolean;
  issues: string[];
}

export async function status(target: SshTarget): Promise<PanelStatus> {
  const res = await run(
    target,
    `echo "SERVICE=$(systemctl is-active xuione 2>/dev/null)"
echo "NGINX=$(pgrep -u xui -c nginx 2>/dev/null || echo 0)"
echo "FPM=$(pgrep -u xui -f php-fpm 2>/dev/null | wc -l)"
echo "LICENCE=$(/home/xui/status 2>/dev/null | sed -n '/^License/,+2p' | tail -1 | tr -d '\\r')"
echo "RESTARTS=$(journalctl -u xuione --since '-3 min' --no-pager 2>/dev/null | grep -c Stopping)"
echo "CACHELINES=$(ls /home/xui/tmp/cache/lines 2>/dev/null | wc -l)"
echo "FFMPEG=$(pgrep -u xui -c ffmpeg 2>/dev/null || echo 0)"
echo "CRON=$([ -f /home/xui/crons/root_signals.php ] && echo yes || echo no)"`,
    90_000,
  );
  const get = (k: string): string =>
    res.stdout.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? "";

  const licence = get("LICENCE");
  const restarts = Number(get("RESTARTS")) || 0;
  const cronPresent = get("CRON") === "yes";
  const issues: string[] = [];

  if (get("SERVICE") !== "active") issues.push("xuione is not running.");
  if (/failed|STATUS_FAILED/i.test(licence) || !licence) issues.push("Licence check is failing — apply the 2025 patch via the repair tool.");
  // Repeated restarts only mean the loop when the cron that causes it is present.
  // Without it, restarts are someone doing maintenance — including this server's
  // own repair tool, which restarts the panel as its final step.
  if (cronPresent && restarts > 1) {
    issues.push(
      `Service restarted ${restarts} times in 3 minutes and root_signals.php is present — ` +
        `it bounces the panel every minute, killing streams and preventing the cache from building. ` +
        `The repair tool disables it.`,
    );
  }
  if (Number(get("CACHELINES")) === 0) issues.push("File cache is empty — auth.php refuses playback until it is built.");

  return {
    service: get("SERVICE"),
    nginxWorkers: Number(get("NGINX")) || 0,
    phpFpm: Number(get("FPM")) || 0,
    licence,
    restartsLastThreeMin: restarts,
    cacheLines: Number(get("CACHELINES")) || 0,
    ffmpegRunning: Number(get("FFMPEG")) || 0,
    restartCronPresent: cronPresent,
    healthy: issues.length === 0,
    issues,
  };
}

/** Applies the known fixes to an already-installed panel. Each step is idempotent. */
export async function repair(target: SshTarget): Promise<InstallStep[]> {
  const steps = [
    {
      label: "/tmp permissions",
      command: `chmod 1777 /tmp; ls -ld /tmp`,
      timeoutMs: 30_000,
    },
    {
      label: "licence patch (2025)",
      command: `set -e
E74=/home/xui/bin/php/lib/php/extensions/no-debug-non-zts-20190902
CUR=$(sha256sum $E74/xui.so 2>/dev/null | cut -d' ' -f1)
if [ "$CUR" = "${PATCH_74_SHA256}" ]; then echo "already patched"; else
  cp -n $E74/xui.so /root/xui.so.orig.bak 2>/dev/null || true
  cd /tmp && curl -sSL -o ext74.so "${PATCH_74_URL}"
  H=$(sha256sum ext74.so | cut -d' ' -f1)
  [ "$H" = "${PATCH_74_SHA256}" ] || { echo "HASH MISMATCH: $H"; exit 1; }
  install -o xui -g xui -m 550 ext74.so $E74/xui.so; rm -f ext74.so
  echo "patched $H"
fi
grep -qE '^license\\s*=\\s*"[0-9a-fA-F]{16}"' /home/xui/config/config.ini || {
  KEY=$(head -c 8 /dev/urandom | xxd -p)
  sed -i "s/^license\\s*=.*/license     =   \\"$KEY\\"/" /home/xui/config/config.ini
  echo "licence key set"; }`,
      timeoutMs: 300_000,
    },
    {
      label: "disable restart cron",
      command: `[ -f /home/xui/crons/root_signals.php ] && mv /home/xui/crons/root_signals.php /root/root_signals.php.bak && echo moved || echo "already absent"`,
      timeoutMs: 30_000,
    },
    {
      label: "probe sizes",
      command: `mysql -u root xui -e "UPDATE settings SET probesize_ondemand=5000000, stream_max_analyze=10000000;" 2>&1
mysql -u root xui -e "UPDATE streams SET probesize_ondemand=8000000 WHERE probesize_ondemand < 5000000;" 2>&1
echo ok`,
      timeoutMs: 60_000,
    },
    {
      // Playback is refused with USER_DISALLOW_EXT when these hold names
      // instead of the ids from output_formats (1 m3u8, 2 ts, 3 rtmp).
      label: "output formats to ids",
      command: `mysql -u root xui -e "UPDATE users_packages SET output_formats='[1,2,3]' WHERE output_formats LIKE '%\\"ts\\"%' OR output_formats IS NULL OR output_formats='[]';" 2>&1
mysql -u root xui -e "UPDATE \\\`lines\\\` SET allowed_outputs='[1,2,3]' WHERE allowed_outputs LIKE '%\\"ts\\"%' OR allowed_outputs IS NULL OR allowed_outputs='[]';" 2>&1
echo "packages: $(mysql -u root xui -N -e 'SELECT GROUP_CONCAT(output_formats) FROM users_packages;' 2>/dev/null)"
echo "lines: $(mysql -u root xui -N -e 'SELECT GROUP_CONCAT(allowed_outputs) FROM \\\`lines\\\`;' 2>/dev/null)"`,
      timeoutMs: 60_000,
    },
    {
      label: "restart and rebuild cache",
      command: `systemctl restart xuione; sleep 18
echo "service: $(systemctl is-active xuione)"
echo "cached lines: $(ls /home/xui/tmp/cache/lines 2>/dev/null | wc -l)"
/home/xui/status 2>&1 | sed -n '/^License/,+2p' | tail -1`,
      timeoutMs: 300_000,
    },
  ];
  const results = await runScript(target, steps);
  return results.map(({ label, result }) => summarise(label, result));
}
