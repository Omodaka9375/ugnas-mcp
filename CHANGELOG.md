# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.1] — 2026-10-17

Production-hardening release, validated against a real UGREEN NAS (UGOS,
Debian 12 base, rk3588).

### Fixed
- `files.list`: filter the structural `.` / `..` entries from listings.
- `files.list`: a nonexistent path now raises "Path not found on the NAS"
  instead of masquerading as an empty directory.
- `backup.create`: warns (in the dry-run plan) when the archive destination
  is inside the source directory — tar then exits 1 with "file changed as we
  read it" and the archive includes a garbage tail entry.

### Added
- Root-path deny-list for `files.remove`: refuses to plan deletion of the
  filesystem root, bare share roots (`/volume1`), top-level system
  directories (`/etc`, `/usr`, …), and UGOS-managed directories under the
  share (`@docker`, `@appstore`, …).
- CI workflow (`.github/workflows/ci.yml`): typecheck, tests, build, both
  smoke tests, and the wiring contract on Ubuntu/Windows × Node 20/22.
- Static explainer page (`docs/index.html`) for GitHub Pages.

### Security
- `backup.schedule`: job `name` validated as a single word
  (`[A-Za-z0-9._-]`, previously raw-interpolated into a cron-run shell script
  — command-injection risk) and `cron` validated as exactly five fields;
  crontab filtering switched to fixed-string `grep -vF`.
- `backup.create`: archive name passed through `posix.basename` (no `../`
  placement outside the destination).
- SSH executor: connect race cached (no double-connect), dropped
  connections reconnect instead of crashing on an unhandled "error" event,
  exec timeouts KILL and close the channel, host-key pinning compares
  fingerprints padding-insensitively.
- Confirm-time argument cross-check: a token issued for one set of
  arguments refuses to execute a differently-argued call.
- HTTP transport: non-loopback binds refused without explicit
  `UGNAS_HTTP_ALLOW_REMOTE=1`; request body capped at 1 MiB.
- `files.thumbnail`: writing the thumbnail to the local machine is now
  gated behind the confirmation token like `files.download`.
- BusyBox fallbacks for `ls`/`find` with cached GNU capability probes;
  `system.pools` parsers rebuilt against real `vgs`/`btrfs`/`lsblk -P`
  output.

### Removed
- Dead code: `SystemService.dockerVersion()`,
  `NetworkService.dockerNetworks()`/`dockerNetworkInspect()` (duplicates of
  `DockerService`), `shqArgs()`.

## [0.1.0]

Initial release: 39 MCP tools for UGREEN NAS (UGOS) over SSH/SFTP — system,
Docker, files, backup, and network groups with a dry-run/confirm safety
model.