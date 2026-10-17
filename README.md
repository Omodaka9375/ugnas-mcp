# ugnas-mcp

[![CI](https://github.com/Omodaka9375/ugnas-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Omodaka9375/ugnas-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ugnas-mcp)](https://www.npmjs.com/package/ugnas-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-black)](./LICENSE)

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
| **Files & data** | `files.list`, `files.usage`, `files.find`, `files.thumbnail`, `files.mkdir`, `files.copy`, `files.move`, `files.remove`, `files.upload`, `files.download`, `files.sync` | thumbnail/mkdir/copy/move/remove/upload/download/sync are gated |
| **Backup** | `backup.create`, `backup.list`, `backup.verify`, `backup.restore`, `backup.schedule` | create/restore/schedule are gated |
| **Networks** | `network.interfaces`, `network.routes`, `network.ports` | read-only |

**39 tools total.** `system.pools` reports mdadm array + degradation state, LVM volume/logical/physical
volumes, btrfs devices, block devices, and filesystems.

`files.find` searches a directory tree by name glob and/or extension (returns path, size, modified
time). `files.thumbnail` renders a preview of an image or a video frame with `ffmpeg` on the NAS and
downloads it locally — read-only with respect to your NAS data (only a `/tmp` scratch file is written
and removed), but **writing the thumbnail to the local machine is gated**: the first call returns a
dry-run plan, and you confirm with the token to write the local file. Requires `ffmpeg` on the NAS
(present on UGOS by default).

`files.list` and `files.find` prefer GNU coreutils flags (`ls --time-style=long-iso`, `find -printf`);
when those are unavailable (BusyBox), they fall back to `ls -1p` and `find -exec stat` so they keep
working — with size/mtime zeroed out for plain `ls` where BusyBox can't report them.

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

At confirm time, the arguments of the confirming call are cross-checked against the plan-time
arguments captured in the token: if they differ, the tool refuses and asks you to re-run for a fresh
plan (so a stale token can never execute a differently-argued action).

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
| `sftpRoot` | no | The directory the **SFTP subsystem** is rooted at. On UGOS, SFTP is chrooted to the share root, so an exec path like `/volume1/docker/x` must be requested over SFTP as `/docker/x`; set this to the chroot root (defaults to `defaultShare`). Use `"/"` if your NAS does not chroot SFTP. |
| `hostKeySha256` | no | When set, the SSH host key is pinned and enforced (e.g. `SHA256:...`). Compare is padding-insensitive, so the canonical fingerprint from `ssh-keygen -lf` works as-is. |
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

## Install & run

Published on npm as [`ugnas-mcp`](https://www.npmjs.com/package/ugnas-mcp). Run it directly —
no clone, no build:

```bash
npx ugnas-mcp
# or install it once:
npm install -g ugnas-mcp
ugnas-mcp
```

That starts the stdio MCP server. It reads its config from `~/.ugnas-mcp/config.json`
(or `UGNAS_MCP_CONFIG` / `UGNAS_*` env vars — see [Configuration](#configuration)).

### Wiring it into an MCP client

Point your client at the official package (stdio):

```json
{
  "mcpServers": {
    "ugnas": {
      "command": "npx",
      "args": ["-y", "ugnas-mcp"],
      "env": { "UGNAS_MCP_CONFIG": "/absolute/path/to/config.json" }
    }
  }
}
```

Or, if you installed it globally, `"command": "ugnas-mcp"` with no args.

### Optional HTTP transport

The server is **stdio by default**. Set `UGNAS_HTTP_PORT` to *also* expose a streamable HTTP
transport (both run side by side):

```bash
UGNAS_HTTP_HOST=127.0.0.1 UGNAS_HTTP_PORT=4110 ugnas-mcp
```

- `POST http://127.0.0.1:4110/mcp` — JSON-RPC (stateless; a fresh session per request, max 1 MiB body).
- `GET  http://127.0.0.1:4110/health` — liveness + target host.

It binds to loopback by default. `UGNAS_HTTP_HOST=0.0.0.0` (or any non-loopback address) is **refused
unless `UGNAS_HTTP_ALLOW_REMOTE=1` is also set** — the `/mcp` endpoint has no authentication, and
confirmation tokens are process-wide, so only opt in if the port is secured by something else
(reverse proxy with auth, VPN, etc.).

## Prerequisites on the NAS

- **SSH enabled** (UGOS: *Control Panel → Terminal & SNMP*).
- The SSH user can run `docker` (be in the `docker` group) and, for scheduled backups, use `crontab`.
- `tar`, `df`, `du`, `ip`, `ss` are present on UGOS — these are standard.
- `backup.schedule` job names must be plain words (`[A-Za-z0-9._-]`) — they are embedded in a
  generated shell script and a crontab line, so anything else is rejected up front.
- `rsync` is **optional**, used only by `files.sync`. If it's missing you get a note explaining how
  to install it or how to enable the built-in `cp` fallback (`files.sync { fallback: "cp" }`); every
  other file tool works without rsync.

## Development

Everything below is for working **on** the server, not running it — users get `npx ugnas-mcp`
from npm. CI (GitHub Actions) runs the same chain on every push and pull request:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build
npm run smoke       # boots the built server, checks tools/list over stdio
npm run smoke:http  # boots with UGNAS_HTTP_PORT and checks /health + /mcp
```

Run from source during development: `npm run dev`.

Releasing: `npm publish` runs `prepublishOnly` (typecheck → tests → build → smoke), so a broken
state can't ship. See [`CHANGELOG.md`](./CHANGELOG.md).

## Design notes

- `src/config.ts` — validation and resolution of the single NAS target (no defaults that encode a
  specific device).
- `src/ssh/` — the `CommandExecutor` interface, the `ssh2`-backed `SshExecutor`, and shell quoting.
- `src/safety/` — the dry-run/confirmation model.
- `src/services/` — one module per tool group; each takes a `ServiceContext`.
- `src/mcp/` — server construction and tool registration.

## License

MIT
