import posix from "node:path/posix";

import type { ResolvedNasConfig } from "../config.js";
import type { CommandExecutor, ExecResult } from "../ssh/sshExecutor.js";
import {
  commandsFromPending,
  type ExecutionResult,
  type PlannedAction,
  type PlanResult
} from "../safety/plan.js";
import type { ServiceContext } from "./context.js";

export type ToolOutcome = PlanResult | ExecutionResult;

export async function execChecked(
  executor: CommandExecutor,
  command: string,
  options?: { allowNonZero?: boolean }
): Promise<ExecResult> {
  const result = await executor.exec(command);
  if (result.code !== 0 && options?.allowNonZero !== true) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`Remote command failed (exit ${result.code}): ${command}${detail ? `\n${detail}` : ""}`);
  }
  return result;
}

/** Resolve a user-supplied path: absolute paths pass through, relative join the share root. */
export function resolveRemotePath(config: ResolvedNasConfig, input: string): string {
  if (input.startsWith("/")) {
    return posix.normalize(input);
  }
  return posix.normalize(posix.join(config.defaultShare, input));
}

/**
 * Map an absolute exec path to the path the (possibly chrooted) SFTP subsystem
 * expects. On UGOS, SFTP is rooted at the share root, so `/volume1/docker/x`
 * must be requested as `/docker/x`.
 */
export function toSftpPath(config: ResolvedNasConfig, execPath: string): string {
  const root = config.sftpRoot.replace(/\/+$/, "");
  if (root === "" || root === "/") {
    return execPath;
  }
  if (execPath === root) {
    return "/";
  }
  if (execPath.startsWith(`${root}/`)) {
    return execPath.slice(root.length);
  }
  // Outside the share root — pass through and let SFTP decide.
  return execPath;
}

/**
 * Like resolveRemotePath but preserves a trailing slash, which is significant for
 * rsync (source with trailing slash copies the *contents*, without it copies the dir).
 */
export function resolveRemotePathPreserveTrailing(config: ResolvedNasConfig, input: string): string {
  const resolved = resolveRemotePath(config, input);
  return /\/+$/.test(input) && !resolved.endsWith("/") ? `${resolved}/` : resolved;
}

export function toExecutionResult(
  action: string,
  results: ExecResult[]
): ExecutionResult {
  return {
    executed: true,
    action,
    results: results.map((result) => ({
      command: result.command,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    }))
  };
}

/**
 * The core safety gate for every mutating tool: without a token, return a
 * dry-run plan (with a fresh confirmation token). With a token, consume it and
 * run the exact commands captured at plan time.
 */
export async function planOrExecute(
  ctx: ServiceContext,
  plan: PlannedAction,
  confirmationToken: string | undefined
): Promise<ToolOutcome> {
  if (!confirmationToken) {
    return ctx.confirmations.issue(plan);
  }

  const pending = ctx.confirmations.consume(confirmationToken, plan.action);
  const results: ExecResult[] = [];
  for (const command of commandsFromPending(pending)) {
    // Execute every planned command; report exit codes rather than aborting so
    // the caller sees the full picture (e.g. one failing rm among several).
    results.push(await execChecked(ctx.executor, command, { allowNonZero: true }));
  }
  return toExecutionResult(plan.action, results);
}

export function makePlan(input: {
  action: string;
  summary: string;
  commands: string[];
  payload?: Record<string, unknown>;
  warnings?: string[];
  note?: string;
}): PlannedAction {
  return {
    action: input.action,
    summary: input.summary,
    requiresConfirmation: true,
    dryRun: true,
    commands: input.commands,
    warnings: input.warnings ?? [],
    ...(input.note ? { note: input.note } : {}),
    payload: input.payload ?? {}
  };
}

/**
 * Split a single combined stdout into named sections produced by
 * `echo '###NAME###'` markers. Lets one round-trip gather many read commands.
 */
export function parseSections(stdout: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const marker = /^###([A-Z0-9_]+)###$/;
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current !== null) {
      sections[current] = buffer.join("\n").trim();
    }
  };

  for (const line of stdout.split(/\r?\n/)) {
    const match = marker.exec(line.trim());
    if (match && match[1]) {
      flush();
      current = match[1];
      buffer = [];
      continue;
    }
    if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/** Wrap commands so each is emitted under a parseable marker section. */
export function sectionCommand(name: string, command: string): string {
  return `echo '###${name}###'; ${command} 2>&1;`;
}

/** Parse `docker --format '{{json .}}'` output: one JSON object per line. */
export function parseJsonLines<T = Record<string, unknown>>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip lines that are not valid JSON (e.g. banners from the daemon).
    }
  }
  return out;
}

export type FoundEntry = {
  path: string;
  name: string;
  sizeBytes: number;
  sizeHuman: string;
  modified: string;
  extension: string;
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return String(bytes);
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value >= 10 ? 0 : 1);
  return `${rounded} ${units[unit]}`;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Parse `find … -printf '%s\t%T@\t%p\n'` output: size (bytes), mtime (epoch
 * seconds, possibly fractional), then the path (which may contain spaces).
 */
export function parseFindOutput(stdout: string): FoundEntry[] {
  const entries: FoundEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) {
      continue;
    }
    const firstTab = line.indexOf("\t");
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      continue;
    }
    const sizeRaw = line.slice(0, firstTab);
    const mtimeRaw = line.slice(firstTab + 1, secondTab);
    const path = line.slice(secondTab + 1);
    if (!path) {
      continue;
    }
    const sizeBytes = Number(sizeRaw);
    const mtimeSeconds = Number(mtimeRaw);
    const name = path.slice(path.lastIndexOf("/") + 1);
    entries.push({
      path,
      name,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
      sizeHuman: formatBytes(Number.isFinite(sizeBytes) ? sizeBytes : 0),
      modified: Number.isFinite(mtimeSeconds) ? new Date(mtimeSeconds * 1000).toISOString() : "",
      extension: extensionOf(name)
    });
  }
  return entries;
}

export type ParsedLsEntry = {
  permissions: string;
  links: number;
  owner: string;
  group: string;
  sizeBytes: number;
  modified: string;
  name: string;
  type: "file" | "dir" | "link" | "other";
};

/**
 * Parse `ls -la --time-style=long-iso` output. The name is taken as everything
 * after the fixed columns so filenames containing spaces survive intact.
 */
export function parseLsLong(input: string): ParsedLsEntry[] {
  const entries: ParsedLsEntry[] = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) {
      continue;
    }
    if (line.startsWith("total ")) {
      continue;
    }

    // cols: perms links owner group size date time name...
    const match = /^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.*)$/.exec(
      line
    );
    if (!match) {
      continue;
    }

    const [, permissions = "", links = "0", owner = "", group = "", size = "0", date = "", time = "", name = ""] =
      match;

    const type: ParsedLsEntry["type"] = permissions.startsWith("d")
      ? "dir"
      : permissions.startsWith("l")
        ? "link"
        : permissions.startsWith("-")
          ? "file"
          : "other";

    entries.push({
      permissions,
      links: Number(links),
      owner,
      group,
      sizeBytes: Number(size),
      modified: `${date} ${time}`,
      name,
      type
    });
  }
  return entries;
}
