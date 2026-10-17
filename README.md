# ugnas-mcp

A **generic** MCP (Model Context Protocol) server for **UGREEN NAS** devices running UGOS,
talking to the NAS over **SSH** (with SFTP for file transfers).

Unlike most existing UGREEN NAS integrations, **nothing here is hard-coded** — no fixed IPs,
subnets, usernames, or share names. Every target-specific value comes from your config, so the
same server works for anyone's NAS.

## What it does

Organized the way a NAS owner actually thinks about daily operations:

| Group | Tools | Mutating? |
| --- | --- | --- |
| **Connection & system** | `system.status`, `system.info`, `system.pools` | read-only |
| **Docker** | `docker.containers.*` (list/inspect/logs/start/stop/restart/remove), `docker.images.*` (list/pull/remove), `docker.networks.*` (list/inspect/create/remove/connect/disconnect), `docker.compose` | start/stop/restart/pull/remove/create/compose are gated |
| **Files & data** | `files.list`, `files.usage`, `files.mkdir`, `files.copy`, `files.move`, `files.remove`, `files.upload`, `files.download`, `files.sync` | mkdir/copy/move/remove/upload/download/sync are gated |
| **Backup** | `backup.create`, `backup.list`, `backup.verify`, `backup.restore`, `backup.schedule` | create/restore/schedule are gated |
| **Networks** | `network.interfaces`, `network.routes`, `network.ports` | read-only |

**37 tools total.** `system.pools` reports mdadm array + degradation state, LVM volume/logical/physical
volumes, btrfs devices, block devices, and filesystems.

### `files.sync` and the rsync fallback

`files.sync` uses **rsync** for fast, resumable NAS↔NAS copies, with `--delete` mirroring and an
rsync `--dry-run` pre-flight. rsync is **not installed on UGOS by default**, so:

- **Default (`fallback: "refuse"`)** — if rsync is missing, the dry-run plan still shows the rsync
  command but adds a `note` telling you how to install rsync (Entware: `opkg install rsync`) **or**
  how to turn on the fallback. Nothing runs until you confirm.
- **Opt in (`fallback: "cp"`)** — the tool instead falls back to a built-in `cp -a` copy. The plan's
  `note` explains this, and `warnings` call out what the fallback can't do: no `--delete` mirroring,
  no rsync `--dry-run`, and `extraArgs` are ignored.

So you opt in per call by passing `fallback: "cp"`. Nothing changes unless you ask for it.

## Safety model — dry-run first, then confirm

Every **mutating** tool has two phases:

1. **Call without a token** → returns a *dry-run plan*: the exact shell commands it *would* run,
   a human summary, any warnings, and a short-lived `confirmationToken`.
2. **Call again with `confirmToken`** → the token is validated (action-bound, single-use, expires
   in 10 minutes) and the **exact commands captured at plan time** are executed.

Read-only tools never need a token. This makes "copy my data", "pull this image", or
"restart that container" reviewable before anything changes.

All user-supplied values (paths, container names, image tags) are POSIX-shell-quoted before being
interpolated into a remote command, so they cannot break out into arbitrary command execution.

## Configuration

The server reads a JSON config from `~/.ugnas-mcp/config.json` (override with the
`UGNAS_MCP_CONFIG` environment variable). See [`config.example.json`](./config.example.json).

```json
{
  "name": "home-nas",
  "host": "192.168.1.50",
  "port": 22,
  "username": "admin",
  "auth": { "type": "key", "privateKeyPath": "~/.ssh/id_ed25519" },
  "defaultShare": "/volume1",
  "commandTimeoutMs": 60000
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `host` | yes | IP or hostname of the NAS. |
| `port` | no | SSH port, default `22`. |
| `username` | yes | SSH user. |
| `auth` | yes | `{ "type": "key", "privateKeyPath": "..." }` (recommended, supports `passphrase`) or `{ "type": "password", "password": "..." }`. `privateKeyPath` may also be raw inline PEM. |
| `defaultShare` | no | Base directory for **relative** tool paths, default `/volume1`. |
| `hostKeySha256` | no | When set, the SSH host key is pinned and enforced (e.g. `SHA256:...`). |
| `commandTimeoutMs` | no | Per-command timeout, default `60000`. |

### Environment-variable overrides

Useful for CI or secret injection. Env values win over the file:

```bash
UGNAS_HOST=192.168.1.50
UGNAS_PORT=22
UGNAS_USER=admin
UGNAS_KEY_PATH=~/.ssh/id_ed25519      # or UGNAS_AUTH_TYPE=password + UGNAS_PASSWORD
UGNAS_DEFAULT_SHARE=/volume1
UGNAS_HOST_KEY_SHA256=SHA256:...
```

### Relative vs absolute paths

File/backup tools accept either. An absolute path is used as-is; a relative path is joined onto
`defaultShare`:

```
files.list("media")  ->  /volume1/media
files.list("/mnt/x")  ->  /mnt/x
```

## Build & run

```bash
npm install
npm run build
node dist/src/server.js          # stdio MCP server
```

Run from source during development:

```bash
npm run dev
```

### Wiring it into an MCP client

Add a server entry pointing at the built binary (stdio):

```json
{
  "command": "node",
  "args": ["/absolute/path/to/ugnas-mcp/dist/src/server.js"],
  "env": { "UGNAS_MCP_CONFIG": "/absolute/path/to/config.json" }
}
```

### Optional HTTP transport

The server is **stdio by default**. Set `UGNAS_HTTP_PORT` to *also* expose a streamable HTTP
transport (both run side by side):

```bash
UGNAS_HTTP_HOST=127.0.0.1 UGNAS_HTTP_PORT=4110 node dist/src/server.js
```

- `POST http://127.0.0.1:4110/mcp` — JSON-RPC (stateless; a fresh session per request).
- `GET  http://127.0.0.1:4110/health` — liveness + target host.

It binds to loopback by default; only change `UGNAS_HTTP_HOST` if you intend remote access and have
secured it (e.g. behind a reverse proxy or VPN).

## Prerequisites on the NAS

- **SSH enabled** (UGOS: *Control Panel → Terminal & SNMP*).
- The SSH user can run `docker` (be in the `docker` group) and, for scheduled backups, use `crontab`.
- `tar`, `df`, `du`, `ip`, `ss` are present on UGOS — these are standard.
- `rsync` is **optional**, used only by `files.sync`. If it's missing you get a note explaining how
  to install it or how to enable the built-in `cp` fallback (`files.sync { fallback: "cp" }`); every
  other file tool works without rsync.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build
npm run smoke       # boots the built server, checks tools/list over stdio
npm run smoke:http  # boots with UGNAS_HTTP_PORT and checks /health + /mcp
```

Tests cover the confirmation-token safety gate, config loading/validation, shell quoting, rsync
gating, and the read-parsers — all against a `FakeExecutor`, so **no real NAS is required** to run them.

## Design notes

- `src/config.ts` — validation and resolution of the single NAS target (no defaults that encode a
  specific device).
- `src/ssh/` — the `CommandExecutor` interface, the `ssh2`-backed `SshExecutor`, and shell quoting.
- `src/safety/` — the dry-run/confirmation model.
- `src/services/` — one module per tool group; each takes a `ServiceContext`.
- `src/mcp/` — server construction and tool registration.

## License

MIT
