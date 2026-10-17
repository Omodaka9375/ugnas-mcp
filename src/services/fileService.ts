import { writeFileSync } from "node:fs";

import { shq } from "../ssh/shellQuote.js";
import { type ExecutionResult } from "../safety/plan.js";
import type { ServiceContext } from "./context.js";
import {
  execChecked,
  makePlan,
  parseFindOutput,
  parseLsLong,
  payloadMismatch,
  planOrExecute,
  resolveRemotePath,
  resolveRemotePathPreserveTrailing,
  toSftpPath,
  type FoundEntry,
  type ParsedLsEntry,
  type ToolOutcome
} from "./util.js";

/** Probe: does `ls` support GNU `--time-style=long-iso`? (BusyBox does not.) */
export const LS_ISO_PROBE =
  "ls --time-style=long-iso -d / >/dev/null 2>&1 && echo yes || echo no";

/** Probe: does `find` support GNU `-printf`? (BusyBox does not.) */
export const FIND_PRINTF_PROBE =
  "find / -maxdepth 0 -printf x >/dev/null 2>&1 && echo yes || echo no";

export class FileService {
  private lsIsoProbe: Promise<boolean> | null = null;
  private findPrintfProbe: Promise<boolean> | null = null;

  constructor(private readonly ctx: ServiceContext) {}

  private async toolYesNo(probeCommand: string): Promise<boolean> {
    try {
      const { stdout } = await execChecked(this.ctx.executor, probeCommand, { allowNonZero: true });
      return stdout.trim() === "yes";
    } catch {
      return false;
    }
  }

  /** Capability probes are cached per service instance (one round-trip each). */
  private async gnuLs(): Promise<boolean> {
    this.lsIsoProbe ??= this.toolYesNo(LS_ISO_PROBE);
    return this.lsIsoProbe;
  }

  private async gnuFind(): Promise<boolean> {
    this.findPrintfProbe ??= this.toolYesNo(FIND_PRINTF_PROBE);
    return this.findPrintfProbe;
  }

  async list(directory: string): Promise<{ path: string; entries: ParsedLsEntry[] }> {
    const resolved = resolveRemotePath(this.ctx.config, directory);

    let stdout: string;
    if (await this.gnuLs()) {
      ({ stdout } = await execChecked(
        this.ctx.executor,
        `ls -la --time-style=long-iso ${shq(resolved)} 2>&1 || true`
      ));
    } else {
      // BusyBox fallback: names with a dir marker ('/' suffix); sizes unknown.
      ({ stdout } = await execChecked(
        this.ctx.executor,
        `ls -1p ${shq(resolved)} 2>&1 || true`
      ));
    }

    const entries = (await this.gnuLs()
      .then((gnu) => (gnu ? parseLsLong(stdout) : parseLsPlain(stdout)))).filter(
      // `.` and `..` are structural noise, not directory content.
      (entry) => entry.name !== "." && entry.name !== ".."
    );

    // A nonexistent path must not masquerade as an empty directory.
    if (entries.length === 0 && /No such file or directory/.test(stdout)) {
      throw new Error(`Path not found on the NAS: ${resolved}`);
    }

    return { path: resolved, entries };
  }

  /**
   * Search for files by name glob, extension, and/or type. Read-only. Uses GNU
   * find `-printf` for size + mtime, then filters the small result set in JS so
   * the same predicates work even on BusyBox find.
   */
  async find(input: {
    path: string;
    name?: string;
    extensions?: string[];
    type?: "file" | "dir";
    maxDepth?: number;
    limit?: number;
  }): Promise<{ path: string; count: number; truncated: boolean; entries: FoundEntry[] }> {
    const resolved = resolveRemotePath(this.ctx.config, input.path);
    const type = input.type ?? "file";
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);

    const parts = ["find", shq(resolved)];
    if (typeof input.maxDepth === "number" && input.maxDepth > 0) {
      parts.push("-maxdepth", String(Math.floor(input.maxDepth)));
    }
    if (type === "file" || type === "dir") {
      parts.push("-type", type === "file" ? "f" : "d");
    }
    if (await this.gnuFind()) {
      parts.push("-printf", shq("%s\\t%T@\\t%p\\n"));
    } else {
      // BusyBox fallback: no -printf, but -exec + stat -c works; '|'
      // separators are parsed by parseFindOutput.
      parts.push("-exec", "stat", "-c", shq("%s|%Y|%n"), "{}", "+");
    }
    // `find` exits non-zero when it can't descend into some subdirectory
    // (permission denied); we still want the results it did produce.
    parts.push("2>/dev/null || true");

    const { stdout } = await execChecked(this.ctx.executor, parts.join(" "));
    let entries = parseFindOutput(stdout);

    if (input.name) {
      const pattern = globToRegExp(input.name);
      entries = entries.filter((entry) => pattern.test(entry.name));
    }
    if (input.extensions && input.extensions.length > 0) {
      const wanted = new Set(input.extensions.map((ext) => ext.replace(/^\./, "").toLowerCase()));
      entries = entries.filter((entry) => wanted.has(entry.extension));
    }

    const total = entries.length;
    if (total > limit) {
      entries = entries.slice(0, limit);
    }

    return { path: resolved, count: entries.length, truncated: total > limit, entries };
  }

  /**
   * Generate a preview thumbnail on the NAS with ffmpeg (image or video frame),
   * download it to the local machine, and remove the remote temp file.
   *
   * Read-only with respect to user data: the only NAS write is a temp file under
   * /tmp, which is deleted before returning.
   */
  async thumbnail(input: {
    path: string;
    width?: number;
    time?: string;
    localPath: string;
    token?: string;
  }): Promise<
    | {
        source: string;
        localPath: string;
        kind: "image" | "video";
        width: number;
        bytes: number;
        engine: string;
      }
    | ToolOutcome
  > {
    const source = resolveRemotePath(this.ctx.config, input.path);
    const width = Math.min(Math.max(input.width ?? 640, 16), 4096);
    const kind = mediaKind(input.path);

    const ffmpegOk = await this.toolAvailable("ffmpeg");
    if (!ffmpegOk) {
      throw new Error(
        "ffmpeg was not found on the NAS, so thumbnails cannot be generated. " +
          "Install ffmpeg (e.g. via Entware: `opkg install ffmpeg`) and retry."
      );
    }

    const remoteTemp = `/tmp/ugnas-thumb-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`;

    // `-pix_fmt yuvj420p` forces a JPEG-friendly full-range format, avoiding
    // mjpeg encoder failures on sources with yuv444p / non-standard range
    // (common with HEVC video frames). `test -s` makes the exit code reflect a
    // non-empty output, since ffmpeg can exit 0 while writing nothing.
    const render = async (seekExpr: string): Promise<boolean> => {
      const command =
        `ffmpeg -hide_banner -loglevel error -y ${seekExpr}-i ${shq(source)} ` +
        `-frames:v 1 -vf ${shq(`scale=${width}:-2`)} -pix_fmt yuvj420p -q:v 3 ${shq(remoteTemp)} ` +
        `&& test -s ${shq(remoteTemp)}`;
      const result = await this.ctx.executor.exec(command);
      return result.code === 0;
    };

    try {
      const requestedSeek = kind === "video" ? `-ss ${shq(input.time ?? "00:00:01")} ` : "";
      let ok = await render(requestedSeek);
      if (!ok && requestedSeek) {
        // Seeking can land past the last decodable frame (e.g. short clips or
        // streams with a broken tail) — retry from the first frame.
        ok = await render("");
      }
      if (!ok) {
        throw new Error(
          `Thumbnail generation produced no data for ${source}. The source may not be a readable image/video, or ffmpeg failed.`
        );
      }

      // Fetch the bytes over exec (base64) rather than SFTP: UGOS chroots SFTP
      // to the share root, so /tmp is not reachable via SFTP.
      const read = await execChecked(
        this.ctx.executor,
        `base64 -w0 ${shq(remoteTemp)} 2>/dev/null || base64 ${shq(remoteTemp)} 2>/dev/null`
      );
      const base64 = read.stdout.replace(/\s+/g, "");
      if (!base64) {
        throw new Error(`Thumbnail file ${remoteTemp} was empty after generation for ${source}.`);
      }
      const bytes = Buffer.from(base64, "base64");

      // Writing to the local machine is a mutation of the MCP host — gate it
      // behind the same dry-run/confirm flow as files.download.
      const plan = makePlan({
        action: "files.thumbnail",
        summary: `Render a thumbnail of ${source} and write it to local file ${input.localPath} (width ${width}, ${kind}).`,
        commands: [
          `ffmpeg (on NAS) -> ${remoteTemp} -> base64 -> local ${input.localPath}`
        ],
        payload: { source, localPath: input.localPath, kind, width }
      });
      if (!input.token) {
        return this.ctx.confirmations.issue(plan);
      }
      const pending = this.ctx.confirmations.consume(input.token, plan.action);
      const mismatch = payloadMismatch(plan.payload, pending.payload);
      if (mismatch) {
        throw new Error(
          `Confirmation token was issued for different arguments (${mismatch}). ` +
            "Re-run the tool without a token for a fresh dry-run plan with the current arguments."
        );
      }

      writeFileSync(input.localPath, bytes);
      return {
        source,
        localPath: input.localPath,
        kind,
        width,
        bytes: bytes.length,
        engine: "ffmpeg"
      };
    } finally {
      // Best-effort cleanup of the remote temp file.
      await this.ctx.executor.exec(`rm -f ${shq(remoteTemp)}`).catch(() => undefined);
    }
  }

  private async toolAvailable(tool: string): Promise<boolean> {
    try {
      const { stdout } = await execChecked(
        this.ctx.executor,
        `command -v ${shq(tool)} >/dev/null 2>&1 && echo yes || echo no`
      );
      return stdout.trim() === "yes";
    } catch {
      return false;
    }
  }

  async usage(input: { path: string; depth?: number }): Promise<{ path: string; report: string }> {
    const resolved = resolveRemotePath(this.ctx.config, input.path);
    const command =
      input.depth && input.depth > 0
        ? `du -h --max-depth=${Math.floor(input.depth)} ${shq(resolved)} 2>&1 | sort -h || true`
        : `du -sh ${shq(resolved)} 2>&1 || true`;
    const { stdout } = await execChecked(this.ctx.executor, command);
    return { path: resolved, report: stdout.trim() };
  }
  makeDirectory(input: { path: string; token?: string }): Promise<ToolOutcome> {
    const resolved = resolveRemotePath(this.ctx.config, input.path);
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "files.mkdir",
        summary: `Create directory ${resolved} (parents included).`,
        commands: [`mkdir -p ${shq(resolved)}`],
        payload: { path: resolved }
      }),
      input.token
    );
  }

  copy(input: { source: string; destination: string; token?: string }): Promise<ToolOutcome> {
    const from = resolveRemotePath(this.ctx.config, input.source);
    const to = resolveRemotePath(this.ctx.config, input.destination);
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "files.copy",
        summary: `Copy ${from} -> ${to} on the NAS.`,
        commands: [`cp -a ${shq(from)} ${shq(to)}`],
        payload: { source: from, destination: to }
      }),
      input.token
    );
  }

  move(input: { source: string; destination: string; token?: string }): Promise<ToolOutcome> {
    const from = resolveRemotePath(this.ctx.config, input.source);
    const to = resolveRemotePath(this.ctx.config, input.destination);
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "files.move",
        summary: `Move/rename ${from} -> ${to} on the NAS.`,
        commands: [`mv ${shq(from)} ${shq(to)}`],
        payload: { source: from, destination: to }
      }),
      input.token
    );
  }

  async remove(input: { path: string; recursive?: boolean; token?: string }): Promise<ToolOutcome> {
    const resolved = resolveRemotePath(this.ctx.config, input.path);

    // Root-path deny-list: deleting the filesystem root, the share root, or
    // any top-level system directory is far more likely a mistake than an
    // intent — refuse outright instead of planning it.
    const reason = deletionDenyReason(resolved, this.ctx.config);
    if (reason) {
      throw new Error(reason);
    }

    const flags = input.recursive === false ? "-f" : "-rf";
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "files.remove",
        summary: `Delete ${resolved} (${flags}).`,
        commands: [`rm ${flags} ${shq(resolved)}`],
        payload: { path: resolved, recursive: input.recursive !== false },
        warnings: ["Deleting files is destructive and cannot be undone."]
      }),
      input.token
    );
  }

  upload(input: { localPath: string; remotePath: string; token?: string }): Promise<ToolOutcome> {
    const remote = resolveRemotePath(this.ctx.config, input.remotePath);
    return this.transferGated(
      {
        action: "files.upload",
        summary: `Upload local file ${input.localPath} -> ${remote} on the NAS.`,
        commands: [`sftp put ${input.localPath} ${remote}`],
        payload: { localPath: input.localPath, remotePath: remote }
      },
      input.token,
      async () => {
        const result = await this.ctx.executor.upload(input.localPath, toSftpPath(this.ctx.config, remote));
        return {
          executed: true,
          action: "files.upload",
          results: [],
          transfer: {
            direction: "upload",
            localPath: result.localPath,
            remotePath: remote,
            bytes: result.bytes
          }
        } satisfies ExecutionResult;
      }
    );
  }

  download(input: { remotePath: string; localPath: string; token?: string }): Promise<ToolOutcome> {
    const remote = resolveRemotePath(this.ctx.config, input.remotePath);
    return this.transferGated(
      {
        action: "files.download",
        summary: `Download ${remote} from the NAS -> local ${input.localPath}.`,
        commands: [`sftp get ${remote} ${input.localPath}`],
        payload: { remotePath: remote, localPath: input.localPath }
      },
      input.token,
      async () => {
        const result = await this.ctx.executor.download(toSftpPath(this.ctx.config, remote), input.localPath);
        return {
          executed: true,
          action: "files.download",
          results: [],
          transfer: {
            direction: "download",
            localPath: result.localPath,
            remotePath: remote,
            bytes: result.bytes
          }
        } satisfies ExecutionResult;
      }
    );
  }

  /**
   * NAS->NAS (or within-NAS) sync via rsync. `delete` mirrors the source by
   * removing extra files at the destination — destructive, so it is called out
   * in the plan and requires the same confirmation as everything else.
   */
  async sync(input: {
    source: string;
    destination: string;
    delete?: boolean;
    dryRun?: boolean;
    extraArgs?: string[];
    fallback?: "refuse" | "cp";
    token?: string;
  }): Promise<ToolOutcome> {
    const source = resolveRemotePathPreserveTrailing(this.ctx.config, input.source);
    const destination = resolveRemotePathPreserveTrailing(this.ctx.config, input.destination);
    const fallback = input.fallback ?? "refuse";

    const rsyncOk = await this.rsyncAvailable();
    const useCp = !rsyncOk && fallback === "cp";

    const warnings: string[] = [];
    const notes: string[] = [];

    if (input.delete) {
      warnings.push("--delete removes files at the destination that are not in the source.");
    }

    let machine: string;
    let command: string;

    if (useCp) {
      // Built-in fallback: copy contents with `cp -a` (no rsync on the NAS).
      machine = "cp (fallback)";
      const srcForCp = source.endsWith("/") ? `${source}.` : `${source}/.`;
      const dstForCp = destination.endsWith("/") ? destination : `${destination}/`;
      command = `mkdir -p ${shq(dstForCp)} && cp -a ${shq(srcForCp)} ${shq(dstForCp)}`;

      notes.push(
        "rsync is not installed on the NAS, so this sync will use the built-in `cp -a` fallback " +
          "(copies files without deleting extras). To use real rsync — including `--delete` mirroring — " +
          "install it on the NAS (e.g. via Entware/opkg: `opkg install rsync`) and re-run; " +
          "or keep using this fallback by passing fallback:\"cp\"."
      );
      if (input.delete) {
        warnings.push("The cp fallback cannot mirror: `--delete` is ignored and extra files at the destination are kept.");
      }
      if (input.dryRun) {
        warnings.push("The cp fallback does not support rsync --dry-run; the copy will run for real when confirmed.");
      }
      if (input.extraArgs && input.extraArgs.length > 0) {
        warnings.push("The cp fallback ignores extraArgs; those rsync flags are dropped.");
      }
    } else {
      machine = "rsync";
      const flags = ["-a", "-H", "--info=stats2", "-h"];
      if (input.delete) {
        flags.push("--delete");
      }
      if (input.dryRun) {
        flags.push("--dry-run");
      }
      for (const extra of input.extraArgs ?? []) {
        flags.push(extra);
      }
      command = `rsync ${flags.map((flag) => shq(flag)).join(" ")} ${shq(source)} ${shq(destination)}`;

      if (!rsyncOk) {
        notes.push(
          "rsync does not appear to be installed on the NAS. Install it (e.g. Entware: `opkg install rsync`), " +
            "or enable the built-in copy fallback by passing fallback:\"cp\" to this tool."
        );
      }
    }

    return planOrExecute(
      this.ctx,
      makePlan({
        action: "files.sync",
        summary: `Sync ${source} -> ${destination} with ${machine}${input.delete && !useCp ? " (mirror: deletes extra files at destination)" : ""}${input.dryRun && !useCp ? " [rsync pre-flight dry-run]" : ""}.`,
        commands: [command],
        payload: {
          source,
          destination,
          delete: Boolean(input.delete),
          rsyncDryRun: Boolean(input.dryRun),
          extraArgs: input.extraArgs ?? [],
          fallback,
          usedEngine: useCp ? "cp" : "rsync"
        },
        warnings,
        ...(notes.length > 0 ? { note: notes.join(" ") } : {})
      }),
      input.token
    );
  }

  private async rsyncAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execChecked(this.ctx.executor, "command -v rsync >/dev/null 2>&1 && echo yes || echo no");
      return stdout.trim() === "yes";
    } catch {
      return false;
    }
  }

  private async transferGated(
    plan: Parameters<typeof makePlan>[0],
    token: string | undefined,
    run: () => Promise<ExecutionResult>
  ): Promise<ToolOutcome> {
    if (!token) {
      return this.ctx.confirmations.issue(makePlan(plan));
    }
    this.ctx.confirmations.consume(token, plan.action);
    return run();
  }
}

const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mkv",
  "mov",
  "avi",
  "webm",
  "m4v",
  "mpg",
  "mpeg",
  "ts",
  "flv",
  "wmv",
  "m2ts"
]);

function mediaKind(path: string): "image" | "video" {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  return VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
}

/** Convert a shell-style glob (`*.mp4`, `IMG_2024*`) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Root-path deny-list for destructive file operations. A deletion target that
 * is the filesystem root, a bare volume root (/volume1), or a direct child of
 * the filesystem root (/etc, /usr, ...) is far more likely a mistake than an
 * intent. UGOS system directories under the share (like `@docker`) are also
 * protected — deleting them can brick the appliance's managed services.
 */
const PROTECTED_TOPLEVEL_UGOS = new Set([
  "@docker",
  "@appstore",
  "@home",
  "@tmp",
  "@upload",
  "@aiconsole",
  "@exif",
  "@search",
  "@thumbnail",
  "@video_web"
]);

export function deletionDenyReason(resolved: string, config: { defaultShare: string }): string | null {
  if (resolved === "/" || resolved === "" || resolved === ".") {
    return "Refusing to delete the filesystem root.";
  }
  // A bare volume root (e.g. "/volume1") or the configured share root.
  if (resolved === config.defaultShare || /^\/volume\d+$/.test(resolved)) {
    return `Refusing to delete a share root (${resolved}). Deleting a share root is almost never intended; if you really must, do it manually over SSH.`;
  }
  // Direct children of the filesystem root are system directories (/etc, /usr, /boot...).
  if (/^\/[^/]+$/.test(resolved) && !resolved.startsWith("/volume")) {
    return `Refusing to delete the top-level system directory ${resolved}.`;
  }
  // UGOS-managed top-level directories under the share.
  if (resolved.startsWith(`${config.defaultShare}/`)) {
    const topLevel = resolved.slice(config.defaultShare.length + 1).split("/")[0] ?? "";
    if (PROTECTED_TOPLEVEL_UGOS.has(topLevel)) {
      return `Refusing to delete the UGOS-managed directory ${resolved} ("${topLevel}") — deleting it can break the appliance's managed services.`;
    }
  }
  return null;
}

/**
 * Parse BusyBox `ls -1p` output (the fallback when GNU --time-style is not
 * available): one name per line, a trailing '/' marking a directory. Sizes and
 * mtimes are unknown, so they are zeroed out rather than invented.
 */
export function parseLsPlain(stdout: string): ParsedLsEntry[] {
  const entries: ParsedLsEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /No such file or directory/.test(line) || line === "total 0") {
      continue;
    }
    const isDir = line.endsWith("/");
    const name = isDir ? line.slice(0, -1) : line;
    if (!name || name === "." || name === "..") {
      continue;
    }
    entries.push({
      permissions: isDir ? "d" : "-",
      links: 0,
      owner: "",
      group: "",
      sizeBytes: 0,
      modified: "",
      name,
      type: isDir ? "dir" : "file"
    });
  }
  return entries;
}
