import { writeFileSync } from "node:fs";

import { shq } from "../ssh/shellQuote.js";
import { type ExecutionResult } from "../safety/plan.js";
import type { ServiceContext } from "./context.js";
import {
  execChecked,
  makePlan,
  parseFindOutput,
  parseLsLong,
  planOrExecute,
  resolveRemotePath,
  resolveRemotePathPreserveTrailing,
  toSftpPath,
  type FoundEntry,
  type ParsedLsEntry,
  type ToolOutcome
} from "./util.js";

export class FileService {
  constructor(private readonly ctx: ServiceContext) {}

  async list(directory: string): Promise<{ path: string; entries: ParsedLsEntry[] }> {
    const resolved = resolveRemotePath(this.ctx.config, directory);
    const { stdout } = await execChecked(
      this.ctx.executor,
      `ls -la --time-style=long-iso ${shq(resolved)} 2>&1 || true`
    );
    return { path: resolved, entries: parseLsLong(stdout) };
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
    parts.push("-printf", shq("%s\\t%T@\\t%p\\n"));
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
  }): Promise<{
    source: string;
    localPath: string;
    kind: "image" | "video";
    width: number;
    bytes: number;
    engine: string;
  }> {
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

  remove(input: { path: string; recursive?: boolean; token?: string }): Promise<ToolOutcome> {
    const resolved = resolveRemotePath(this.ctx.config, input.path);
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
