# xui-mcp-server

An MCP server for XUI.ONE IPTV panels. It covers three layers, so an assistant can take a bare server all the way to a working panel and then run it:

- **Server provisioning** — install, inspect and repair a panel over SSH
- **Admin API** — around sixty management actions, for building integrations
- **Reseller API** — line lifecycle, trials and sub-reseller credits

A stock XUI.ONE install does not serve video. Several defaults are wrong in ways the panel never reports: a licence patch that fails silently, a cron that restarts the service every minute, a probe size too small for ffmpeg to identify codecs, and an output-format field that accepts the wrong shape and then refuses playback with a fake 404. The provisioning tools fix all of them, and [`docs/panel-notes.md`](docs/panel-notes.md) explains each one so the steps are auditable rather than magic.

## Safety model

The reseller and admin APIs talk to a panel holding real customer subscriptions, and a stray call can cancel somebody's service. Mutating actions are therefore opt-in:

| Env | Default | Unlocks |
|---|---|---|
| `XUI_ALLOW_WRITES` | `false` | Everything that creates, renews, changes state or tops up credits |
| `XUI_ALLOW_DELETE` | `false` | `xui_delete_line` (also needs `XUI_ALLOW_WRITES=true`) |
| `XUI_ALLOW_PROVISIONING` | `true` | The four `xui_server_*` tools |
| `XUI_PROVISION_HOSTS` | *(empty — any host)* | Restricts which machines provisioning may touch |

With writes off, the server is safe to point at production: read tools work and writes return an explanatory error instead of touching anything.

Provisioning is on by default because installing panels is the point of it. It opens root SSH sessions on whatever host it is given, so pin `XUI_PROVISION_HOSTS` — or set `XUI_ALLOW_PROVISIONING=false` — if this server runs anywhere you do not fully control.

## Tools

### Reseller API — subscription management

Needs `XUI_URL` + `XUI_API_KEY`.

| Tool | Kind | Purpose |
|---|---|---|
| `xui_get_line` | read | Line state by numeric id: credentials, expiry, package, status |
| `xui_get_user` | read | A panel user / sub-reseller and their credit balance |
| `xui_user_info` | read | The API key owner and the master credit pool |
| `xui_create_line` | write | Provision a line; generates credentials when not supplied |
| `xui_create_trial` | write | Provision a demo line (duration comes from the trial package) |
| `xui_renew_line` | write | Apply a package to an existing line, extending expiry |
| `xui_add_reseller_credits` | write | Top up a sub-reseller |
| `xui_delete_line` | destructive | Permanently remove a line |

### Admin API — building integrations

Needs `XUI_ADMIN_URL` + `XUI_ADMIN_API_KEY` as well. The panel exposes around sixty admin actions; wrapping each as its own tool would swamp an agent's tool list, so related actions are grouped behind an `action` enum and the long tail stays reachable through one escape hatch.

| Tool | Kind | Covers |
|---|---|---|
| `xui_admin_list` | read | 15 collections: users, lines, streams, channels, movies, series, episodes, bouquets, categories, packages, servers, providers, access codes, EPG sources, HMAC keys |
| `xui_admin_logs` | read | 11 feeds: live connections, activity, credits, client, user, stream errors, watch output, system, login, restream, MAG events |
| `xui_admin_set_line_state` | write | enable / disable / ban / unban a line |
| `xui_admin_control_stream` | write | start / stop a stream's transcoder |
| `xui_admin_call` | destructive | Any remaining action — create/edit/delete for users, lines, bouquets, categories, packages, streams, providers, EPG, MAG, Enigma, access codes, HMAC keys |

### Server provisioning — standing a panel up

These tools open a **root SSH session** on a target machine and install software on it. They are **enabled by default**, because standing panels up is what this server is for — set `XUI_ALLOW_PROVISIONING=false` to remove remote execution entirely, and `XUI_PROVISION_HOSTS` to restrict which machines may be touched.

> Worth knowing before you run this anywhere shared: a model driving this server can SSH as root into any host it is given. Pin `XUI_PROVISION_HOSTS` if that is not what you want.

| Tool | Kind | Purpose |
|---|---|---|
| `xui_server_preflight` | read | Is this box suitable? OS, arch, virtualisation, CPU/RAM/disk, existing panel, occupied ports |
| `xui_server_install` | destructive | Clean server → working panel, with the fixes a stock install needs |
| `xui_server_status` | read | Licence, restart loop, file cache, running processes, with plain-language issues |
| `xui_server_repair` | write | Apply the known fixes to an existing panel; idempotent |

`xui_server_install` needs `XUI_ALLOW_WRITES=true` as well. It runs preflight first and **refuses to start if there are blockers** — an existing `/home/xui`, a non-x86_64 architecture, unsupported virtualisation, occupied ports. `force=true` overrides. It takes 30–60 minutes because the dependency stage compiles PHP and ffmpeg.

What a stock install gets wrong, and what these tools fix:

- `/tmp` must stay `1777` — PHP's Zend semaphore lives there and php-fpm will not start without it.
- The 2022 licence patch leaves the panel failing its licence check forever; the 2025 one reports an expiry in 2038.
- `root_signals.php` restarts the whole service **every 60 seconds**, killing streams mid-flight and preventing the file cache from ever being built.
- `probesize_ondemand` defaults to 128000 — about a quarter-second of a 4 Mbit stream, too little for ffmpeg to identify codecs.
- `allowed_outputs` must hold format ids `[1,2,3]`, not names; names are accepted silently and then refused at playback.

Both the payload and the licence patch are pinned by SHA-256 and verified on the target before use. They are still unsigned binaries from community mirrors, executed as root — the tool descriptions say so, and so does this README, because whoever runs it should know.

---

Every tool takes `response_format` (`markdown` default, or `json`) and returns `structuredContent` alongside the text. List and log tools paginate with `limit`/`offset` and trim oversized responses with an explicit note.

Authentication is a plain `api_key` query parameter. The panel also accepts HMAC headers (`X-API-KEY` / `X-Signature` / `X-Timestamp`), but they are an alternative rather than a requirement, so this server uses the simpler form.

## Setup

```bash
npm install
npm run build
```

Copy `.env.example` and fill in what you need. Only `XUI_URL` and `XUI_API_KEY` are required; the admin tools stay dormant until their pair is set, and report what is missing if called.

Getting the two API endpoints from a panel: in the admin UI go to **Management → Access Control → Access Codes** and create one code with **Access Type = Admin API** and another with **Reseller API**. Each becomes a URL path. The key itself is `api_key` on a user's profile — an administrator's for the admin endpoint, a reseller's for the reseller one.

### Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "xui": {
      "command": "node",
      "args": ["/absolute/path/to/xui-mcp-server/dist/index.js"],
      "env": {
        "XUI_URL": "https://panel.example.com/<reseller-api-code>/",
        "XUI_API_KEY": "...",
        "XUI_ADMIN_URL": "https://panel.example.com/<admin-api-code>/",
        "XUI_ADMIN_API_KEY": "...",
        "XUI_ALLOW_WRITES": "false",
        "XUI_PROVISION_HOSTS": "203.0.113.10"
      }
    }
  }
}
```

## Local development against the mock

A faithful mock of the reseller API ships in `mock/`, so you can develop without a live panel:

```bash
npm run mock
```

Then point the server at it:

```bash
XUI_URL=http://127.0.0.1:8899/ XUI_API_KEY=test-key XUI_ALLOW_WRITES=true node dist/index.js
```

The mock seeds line `1612073` (active) and `1735171` (expired), users `3012` (key owner, 88 credits) and `4821` (sub-reseller), and packages `82`/`54` (5h/24h trials), `114` (30d), `134` (1y). It mirrors the panel's habit of serialising numbers as strings.

## API notes

The panel exposes one endpoint switched by `action`, authenticated with `api_key`:

```
GET {XUI_URL}?action=get_line&api_key=...&id=1612073
→ {"status":"STATUS_SUCCESS","data":{"id":"1612073","exp_date":"1793404800",...}}
→ {"status":"STATUS_FAILURE","error":"Invalid API key."}
```

Behaviours worth knowing, all handled by the client:

- **Numbers arrive as strings**, inconsistently between actions. Everything is coerced.
- **`exp_date` is unix seconds.** Tools return both ISO-8601 and the raw integer.
- **`user_info` ignores any id** and always answers for the key owner, so its `credits` is the master pool — a sub-reseller's balance needs `get_user`.
- **`delete_line` returns no `data` key**, only a status.
- **Trial duration lives in the package**, not in a parameter; there is no `packageduration` field.
- **Renewing beats re-creating.** `edit_line` on an expired line reactivates it with the same credentials; creating a new line instead leaves the customer with two accounts for one payment.
- **The reseller API base usually needs a trailing slash** — without it many panels 301 or 404.

### Admin API quirks

These cost real time to discover, and `xui_admin_call` repeats them in its description because they will otherwise bite:

- **Array parameters need PHP bracket notation** — `bouquets[]`, `category_id[]`, `stream_source[]`, `server_id[]`. A JSON string is accepted silently and the field stays empty.
- **Output formats are ids, not names**: 1 = HLS/m3u8, 2 = MPEGTS/ts, 3 = RTMP. A line whose `allowed_outputs` holds `["ts"]` is refused at playback with `USER_DISALLOW_EXT`, reported as a 404.
- **Edit actions blank unspecified fields.** Always send the full set.
- **`create_package` ignores `bouquets[]` and `groups[]`** — set them on `users_packages` directly.
- **Some list actions return a bare JSON array** instead of the envelope. Handled for you.

## Not covered

The Player API (`player_api.php`, `get.php`), which end-user apps call with a line's own credentials. It needs no admin key and is trivially callable over plain HTTP, so wrapping it adds little.

## Testing

Four layers, all runnable against the mock or a real panel:

```bash
npm test                                  # unit — response coercion and error paths
npm run mock &                            # faithful mock of the reseller API
node scripts/smoke.mjs                    # end-to-end against the mock
node scripts/validate-live.mjs            # read-only against a real panel
node scripts/validate-admin.mjs           # admin surface, read-only
PROV_HOST=… PROV_KEY=… \
  node scripts/validate-provision.mjs     # provisioning gates and preflight
```

`validate-provision.mjs` only runs read-only checks by default; pass `RUN_REPAIR=1` to exercise the repair path too, which is idempotent but does restart the panel.

## Licensing and provenance

This tool manages XUI.ONE panels. It does not include XUI.ONE.

XUI.ONE was abandoned by its vendor: the licence server was shut down and there is no official download. The provisioning tools therefore fetch the panel payload and a community licence patch from public mirrors and execute them as root on the target machine. Both artefacts are pinned by SHA-256 and verified on the target before use, and an install aborts on a mismatch — but they are unsigned third-party binaries and you should decide for yourself whether you want that on your server. The tool descriptions and `.env.example` say the same thing.

Nothing in this repository is required to talk to a panel you already run: the reseller and admin tools are plain HTTP clients and work against any XUI.ONE install.

## License

MIT — see [LICENSE](LICENSE).
