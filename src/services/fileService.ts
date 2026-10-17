import { shq } from "../ssh/shellQuote.js";
import { type ExecutionResult } from "../safety/plan.js";
import type { ServiceContext } from "./context.js";
import {
  execChecked,
  makePlan,
  parseLsLong,
  planOrExecute,
  resolveRemotePath,
  resolveRemotePathPreserveTrailing,
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
        const result = await this.ctx.executor.upload(input.localPath, remote);
        return {
          executed: true,
          action: "files.upload",
          results: [],
          transfer: {
            direction: "upload",
            localPath: result.localPath,
            remotePath: result.remotePath,
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
        const result = await this.ctx.executor.download(remote, input.localPath);
        return {
          executed: true,
          action: "files.download",
          results: [],
          transfer: {
            direction: "download",
            localPath: result.localPath,
            remotePath: result.remotePath,
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
