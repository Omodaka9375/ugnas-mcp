# Developing ugnas-mcp

This document is for people working **on** the server. If you just want to *run* it, that's
`npx -y ugnas-mcp` — see the [README](./README.md).

## Prerequisites

- Node ≥ 22 (the published package requires ≥ 20; dev tooling needs more)
- pnpm (`npm i -g pnpm`)
- A real NAS is **not** required to develop — the test suite runs against a `FakeExecutor`.

## Setup

```bash
git clone https://github.com/Omodaka9375/ugnas-mcp.git
cd ugnas-mcp
pnpm install
```

## The command chain

CI (GitHub Actions, `.github/workflows/ci.yml`) runs this exact chain on every push and pull
request, on Ubuntu and Windows, on Node 20 and 22:

```bash
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest — the FakeExecutor suite, no NAS needed
pnpm build        # tsc → dist/
pnpm smoke        # boots the built server, tools/list over stdio
pnpm smoke:http   # boots with UGNAS_HTTP_PORT, checks /health + /mcp
```

Run from source without building: `pnpm dev`.

Live-NAS integration checks (only when you have a reachable target — it uses
`~/.ugnas-mcp/config.json`):

```bash
pnpm integration  # dot-entry filtering, deny-list, self-archive warning, plan→confirm, stale-token
```

## Tests

`tests/` — vitest, all against the `FakeExecutor` in `tests/helpers.ts` (records commands,
returns canned output), so **no real NAS is required**:

- `confirmation.test.ts` — the token lifecycle: single-use, action-bound, expiry.
- `config.test.ts` — config loading, defaults, env overrides, inline key material.
- `shellQuote.test.ts` — `shq()` POSIX quoting, injection containment.
- `services.test.ts` — every service: dry-run gating, SFTP path mapping, the rsync `cp`
  fallback, BusyBox parsing, thumbnail gating, the root-path deny-list, the tar
  self-archive warning.
- `wiring.test.ts` — the **service↔tool contract**: registers the real `registerTools`
  against a recorder and asserts the exact 39-tool set, that every contract method is a
  function, and that `confirmToken` presence matches each tool's mutating status. A dead
  method or a missing registration fails here.

## Releasing

1. Bump `version` in `package.json` **and** `SERVER_VERSION` in `src/mcp/createServer.ts`
   (keep them in sync), and add a `CHANGELOG.md` entry.
2. `npm publish` — the `prepublishOnly` hook runs the full chain first
   (typecheck → tests → build → smoke), so a broken state cannot ship.
   Publishing requires npm CLI ≥ 11.15 and an OTP from 2FA.
3. Push — CI runs the same chain on the release commit.

## Architecture

```text
src/
├── server.ts              entrypoint: stdio + optional stateless HTTP (/mcp, /health)
├── config.ts              zod-validated config; UGNAS_* env overrides win over the file
├── mcp/
│   ├── createServer.ts     McpServer wrapper (name/version)
│   └── toolset.ts          all 39 tool registrations
├── safety/plan.ts         ConfirmationTokenService — the dry-run/confirm core
├── ssh/
│   ├── sshExecutor.ts      CommandExecutor interface + ssh2-backed SshExecutor
│   └── shellQuote.ts       shq() — every user value passes through it
└── services/              one class per tool group, each takes ServiceContext
    ├── systemService       status / info / pools (mdadm, LVM, btrfs, lsblk, blkid parsers)
    ├── dockerService       containers / images / networks / compose
    ├── fileService         list / usage / find / thumbnail / mkdir / copy / move
    │                       / remove / upload / download / sync
    ├── backupService       create / list / verify / restore / schedule
    ├── networkService      interfaces / routes / ports
    └── util.ts             planOrExecute, path resolution, output parsers
```

Design decisions worth knowing before you touch things:

- **Commands are captured at plan time** (`payload.__commands`) and executed verbatim at
  confirm time — intent cannot drift between the dry-run and the execution. The confirming
  call's arguments are cross-checked against the token payload; a mismatch refuses.
- **Every user value passes through `shq()`** (POSIX single-quote escaping) before it is
  interpolated into a remote command. `files.remove` additionally refuses root paths and
  UGOS-managed directories outright.
- **One SSH round-trip for many reads**: `sectionCommand()` wraps commands behind
  `###NAME###` markers and `parseSections()` splits them back out.
- **UGOS chroots SFTP** to the share root: `toSftpPath()` maps exec paths
  (`/volume1/docker/x` → SFTP `/docker/x`), `sftpRoot` config owns the mapping, and
  `files.thumbnail` deliberately reads bytes via base64-over-exec because `/tmp` is
  outside the chroot.
- **BusyBox tolerance**: GNU `ls`/`find` flags are probed once and cached; on BusyBox the
  file tools fall back to `ls -1p` and `find -exec stat`.
- **The HTTP transport is unauthenticated by design** — it binds loopback, refuses
  non-loopback without `UGNAS_HTTP_ALLOW_REMOTE=1`, caps request bodies at 1 MiB, and
  creates a fresh stateless session per request. Put auth in front if you need it off-box.

## Conventions

- Strict TypeScript (`noUncheckedIndexedAccess`, `noImplicitOverride`), zod schemas for all
  tool inputs, ESM with `.js` import extensions (NodeNext).
- Read-only tools never take a `confirmToken`; mutating ones always do, and destructive ones
  additionally set `warnings` in the dry-run plan.
- Windows note: test and toolchain commands run under PowerShell; the remote side is always
  POSIX (`shq()` assumes a POSIX shell on the NAS).