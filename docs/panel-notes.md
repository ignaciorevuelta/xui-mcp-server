# Field notes on XUI.ONE panels

Everything here was established on a real 1.5.13 install, mostly by getting it wrong first. It is the reasoning behind what `xui_server_install` and `xui_server_repair` do, so that the steps do not look arbitrary and get "simplified" back into a broken panel.

## Access codes gate every surface

The panel puts each surface behind a random-looking path called an access code, stored in the `access_codes` table (`code`, `type`, `enabled`, `groups`). The `type` column selects which directory nginx aliases:

| type | Directory | Surface |
|------|-----------|---------|
| 0 | `/home/xui/admin` | Admin panel UI |
| 1 | `/home/xui/reseller` | Reseller panel UI |
| 3 | `/home/xui/includes/api/admin` | Admin API |
| 4 | `/home/xui/includes/api/reseller` | Reseller API |

**A database row is not enough.** The panel also writes `bin/nginx/conf/codes/<CODE>.conf` from `codes/template`, and `nginx.conf` pulls them in with `include codes/*.conf`. A code without its file gets nginx's own 404. `/home/xui/tools access` regenerates them from the table.

Both APIs answer `GET /<code>/?action=…&api_key=…` — no `api.php` in the path. The key is `users.api_key`, one per user, `NULL` until generated, and the API answers as whoever owns the key. HMAC headers (`X-API-KEY` / `X-Signature` / `X-Timestamp`) are an accepted alternative, not a requirement.

A trap worth knowing: `/home/xui/reseller/api.php` — the type-1 panel's internal AJAX — answers JSON and ignores `api_key`. It looks like the reseller API and is not it.

## Things that silently break playback

### `allowed_outputs` holds format ids, not names

`output_formats` maps `access_output_id` → 1 HLS/m3u8, 2 MPEGTS/ts, 3 RTMP. Lines need `allowed_outputs = [1,2,3]` and packages need `output_formats = [1,2,3]`.

Storing `["ts","m3u8","rtmp"]` is accepted without complaint. Playback is then refused with a **spoofed nginx 404** — same body, but `Content-Type: text/html; charset=UTF-8` and 546 bytes against nginx's own `text/html` and 146 bytes.

Lines created through the API inherit this from their package, so fixing the package fixes every line made afterwards.

### The service restarts itself every 60 seconds

Root's crontab — held immutable with `chattr +i`, so `crontab -e` fails with `Operation not permitted` — runs `/home/xui/crons/root_signals.php` every minute, and that restarts the `xuione` unit. The unit's `stop()` runs `killall -u xui`, which takes ffmpeg with it.

Two consequences: no stream survives longer than a minute, and `cache_handler.php` never finishes building `/home/xui/tmp/cache`, which `auth.php` needs before it will serve anything.

Moving the script aside stops it. The cost is that it also dispatches the other jobs in `/home/xui/crons` (EPG, stats, cleanup), so weigh that against needing video to work.

### `probesize_ondemand` defaults to 128000

That is roughly a quarter-second of a 4 Mbit stream — far too little for ffmpeg to identify codecs, so streams fail to start with `not enough frames to estimate rate`. The per-stream column on `streams` is what reaches the command line; the global in `settings` does **not** override it.

### `/tmp` must stay `1777`

PHP puts its Zend semaphore in `/tmp`. If anything resets the permissions — extracting a tarball whose root directory is `0755` will do it — php-fpm dies with `Unable to create lock file: Bad file descriptor` and the panel serves 502s.

## Diagnosing a 404 that should not be one

`auth.php` refuses without touching MySQL, so a query log shows nothing useful. Its last act is appending a base64 blob to `/home/xui/tmp/logs/client_request.log`, which is then removed. Catch it with:

```bash
strace -f -qq -s 500 -e trace=write -o /tmp/php.trace \
  $(pgrep -u xui -f "php-fpm: master" | sed 's/^/-p /')
```

Decode the blob and the reason is in plain text:

```json
{"user_id":"2","stream_id":3,"action":"USER_DISALLOW_EXT","query_string":"token=…&extension=ts"}
```

## Admin API quirks

- **Array parameters need PHP bracket notation** — `bouquets[]`, `category_id[]`, `stream_source[]`, `server_id[]`. A JSON string is accepted silently and the field stays empty.
- **Edit actions blank unspecified fields.** `edit_stream` with only an `id` wipes `category_id` and `stream_source`. Always send the full set.
- **`create_package` ignores `bouquets[]` and `groups[]`** — set them on `users_packages` directly. The table is `users_packages`, not `packages`, and `lines` is a reserved word needing backticks.
- **Some list actions return a bare JSON array** rather than the usual envelope: `get_bouquets`, `get_categories`, `get_packages`, `get_providers`, `get_servers`.
- **`start_stream` takes `id` and `server_id`**, not `stream_id`.

## Sessions are bound to the client IP

Behind a CDN the perceived address changes between requests, so every login bounces straight back to the login page. `bin/nginx/conf/realip_cdn.conf` ships empty; populating it with the CDN's ranges fixes it. `login_logs` makes the diagnosis obvious — consecutive `SUCCESS` rows from different edge addresses.

## Licensing

The vendor shut its licence server down and `xui.one` returns 403. There is no official download; the payload and the patches live on community mirrors.

The widely-mirrored 2022 patch (`xui.so`, 248 KB) leaves `/home/xui/status` reporting `Failed to generate license! Error: STATUS_FAILED` with `license = "cracked"` in `config.ini`. The 2025 patch (`extension_7.4.so`, 498 KB) plus a valid 16-hex key gives `License expires: 2038-01-19` — the 32-bit timestamp ceiling.

`xui_server_install` and `xui_server_repair` pin both artefacts by SHA-256 and abort on a mismatch. They are still unsigned binaries fetched from third-party mirrors and executed as root.

## Deployment shape

- **Ubuntu 20.04 or 22.04, x86_64.** The panel ships precompiled binaries linked against OpenSSL 1.1 and libcurl 7.68; 24.04 needs significant patching and there is no ARM build at all.
- **KVM or bare metal.** OpenVZ and LXC cannot run it.
- **8 GB RAM and 4 cores** is the practical floor.
- Ports: 80, 443 (panel), 8080 (admin), 8880 (RTMP), 25500 (streaming).
- A CDN proxy in front is fine for the admin UI but not for streaming — most only proxy a fixed set of HTTP ports, and self-serve terms commonly restrict video. Use a second, unproxied hostname for anything stream-related.
