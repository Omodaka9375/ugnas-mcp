import posix from "node:path/posix";

import { shq } from "../ssh/shellQuote.js";
import type { ServiceContext } from "./context.js";
import {
  execChecked,
  makePlan,
  parseLsLong,
  parseSections,
  planOrExecute,
  resolveRemotePath,
  sectionCommand,
  type ToolOutcome
} from "./util.js";

export type BackupArchive = {
  name: string;
  sizeBytes: number;
  modified: string;
};

export class BackupService {
  constructor(private readonly ctx: ServiceContext) {}

  create(input: { path: string; destinationDir: string; name?: string; token?: string }): Promise<ToolOutcome> {
    const source = resolveRemotePath(this.ctx.config, input.path);
    const destinationDir = resolveRemotePath(this.ctx.config, input.destinationDir);
    const archiveName = posix.basename(input.name ?? `backup-${stamp()}.tar.gz`);
    const archivePath = posix.join(destinationDir, archiveName);
    const command = `mkdir -p ${shq(destinationDir)} && tar -czf ${shq(archivePath)} -C ${shq(source)} .`;

    return planOrExecute(
      this.ctx,
      makePlan({
        action: "backup.create",
        summary: `Create archive ${archivePath} from ${source}.`,
        commands: [command],
        payload: { path: source, destinationDir, archivePath }
      }),
      input.token
    );
  }

  async list(directory: string): Promise<{ directory: string; archives: BackupArchive[] }> {
    const resolved = resolveRemotePath(this.ctx.config, directory);
    const { stdout } = await execChecked(
      this.ctx.executor,
      `ls -la --time-style=long-iso ${shq(resolved)} 2>&1 || true`
    );
    const archives = parseLsLong(stdout)
      .filter((entry) => entry.type === "file" && /\.(tar\.gz|tgz|tar|zip)$/i.test(entry.name))
      .map((entry) => ({ name: entry.name, sizeBytes: entry.sizeBytes, modified: entry.modified }));
    return { directory: resolved, archives };
  }

  restore(input: { archive: string; destination: string; token?: string }): Promise<ToolOutcome> {
    const archive = resolveRemotePath(this.ctx.config, input.archive);
    const destination = resolveRemotePath(this.ctx.config, input.destination);
    const command = `mkdir -p ${shq(destination)} && tar -xzf ${shq(archive)} -C ${shq(destination)}`;
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "backup.restore",
        summary: `Extract ${archive} into ${destination}.`,
        commands: [command],
        payload: { archive, destination },
        warnings: [
          "Restoring overwrites any files that already exist at the destination.",
          "Test restores into an empty directory before restoring over live data."
        ]
      }),
      input.token
    );
  }

  async verify(archive: string): Promise<{
    archive: string;
    exists: boolean;
    checksum: string | null;
    entryCount: number | null;
    sampleEntries: string[];
  }> {
    const resolved = resolveRemotePath(this.ctx.config, archive);
    const command = [
      sectionCommand("EXISTS", `[ -f ${shq(resolved)} ] && echo yes || echo no`),
      sectionCommand("CHECKSUM", `sha256sum ${shq(resolved)} 2>/dev/null || md5sum ${shq(resolved)} 2>/dev/null || true`),
      sectionCommand("COUNT", `tar -tzf ${shq(resolved)} 2>/dev/null | wc -l || echo 0`),
      sectionCommand("SAMPLE", `tar -tzf ${shq(resolved)} 2>/dev/null | head -n 50 || true`)
    ].join("\n");

    const { stdout } = await execChecked(this.ctx.executor, command);
    const sections = parseSections(stdout);
    const countRaw = (sections.COUNT ?? "").trim();
    const count = Number(countRaw);

    return {
      archive: resolved,
      exists: (sections.EXISTS ?? "").trim() === "yes",
      checksum: (sections.CHECKSUM ?? "").trim() || null,
      entryCount: Number.isFinite(count) ? count : null,
      sampleEntries: (sections.SAMPLE ?? "").split(/\r?\n/).filter(Boolean)
    };
  }

  schedule(input: {
    path: string;
    destinationDir: string;
    cron: string;
    name?: string;
    token?: string;
  }): Promise<ToolOutcome> {
    const source = resolveRemotePath(this.ctx.config, input.path);
    const destinationDir = resolveRemotePath(this.ctx.config, input.destinationDir);
    // `name` lands inside a shell script and a crontab line — keep it a safe
    // single word (letters, digits, dot, underscore, dash only).
    const name = safeJobName(input.name);
    // `cron` becomes five fields of a crontab entry — nothing else.
    const cron = safeCronExpression(input.cron);
    const scriptDir = posix.join(this.ctx.config.defaultShare, ".ugnas-mcp");
    const scriptPath = posix.join(scriptDir, `${name}.sh`);

    const scriptLines = [
      "#!/bin/sh",
      "set -eu",
      `DEST=${shq(destinationDir)}`,
      `SRC=${shq(source)}`,
      "TS=$(date +%Y%m%d-%H%M%S)",
      `mkdir -p "$DEST"`,
      `tar -czf "$DEST/${name}-$TS.tar.gz" -C "$SRC" .`
    ];

    const writeScript = `mkdir -p ${shq(scriptDir)} && printf '%s\\n' ${scriptLines
      .map(shq)
      .join(" ")} > ${shq(scriptPath)} && chmod +x ${shq(scriptPath)}`;

    const cronLine = `${cron} ${scriptPath} # UGNAS_MCP_BACKUP:${name}`;
    const marker = `UGNAS_MCP_BACKUP:${name}`;
    const installCron = `( crontab -l 2>/dev/null | grep -vF ${shq(marker)} ; echo ${shq(cronLine)} ) | crontab -`;

    return planOrExecute(
      this.ctx,
      makePlan({
        action: "backup.schedule",
        summary: `Install cron schedule "${cron}" running ${name} backups of ${source} into ${destinationDir}.`,
        commands: [writeScript, installCron],
        payload: { path: source, destinationDir, cron, name, scriptPath },
        warnings: [
          "This modifies your user crontab (it preserves existing non-managed entries).",
          "The scheduled job runs as the SSH user; ensure it can read the source and write the destination."
        ]
      }),
      input.token
    );
  }
}

/** Job names land inside shell scripts and crontab lines — words only. */
function safeJobName(input: string | undefined): string {
  const fallback = "backup";
  const value = (input ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    if (input === undefined) {
      return fallback;
    }
    throw new Error(
      `Backup job name must contain only letters, digits, dot, underscore or dash (got "${input}").`
    );
  }
  return value;
}

/** A cron expression is exactly five whitespace-separated fields — no more, no less. */
function safeCronExpression(input: string): string {
  const fields = input.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[*@A-Za-z0-9,\-/]+$/u.test(field))) {
    throw new Error(
      `Cron expression must be exactly five fields, e.g. "0 3 * * *" (got "${input}").`
    );
  }
  return fields.join(" ");
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}
