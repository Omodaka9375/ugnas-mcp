import { ConfirmationTokenService, type PlannedAction } from "../src/safety/plan.js";
import type {
  CommandExecutor,
  DownloadResult,
  ExecResult,
  UploadResult
} from "../src/ssh/sshExecutor.js";

/** A confirmation service with a controllable clock and sequential tokens. */
export function deterministicService(ttlMs = 10 * 60 * 1000) {
  const clock = { now: new Date("2020-01-01T00:00:00.000Z") };
  let counter = 0;
  const service = new ConfirmationTokenService({
    now: () => clock.now,
    ttlMs,
    generate: () => `token-${++counter}`
  });

  return {
    issue: (plan: PlannedAction) => service.issue(plan),
    consume: (token: string, action?: string) => service.consume(token, action),
    advance: (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    }
  };
}

export function makePlanForTest(action: string, commands: string[], summary = action): PlannedAction {
  return {
    action,
    summary,
    requiresConfirmation: true,
    dryRun: true,
    commands,
    warnings: [],
    payload: {}
  };
}

/** Records every command it is asked to run; returns a canned result per command. */
export class FakeExecutor implements CommandExecutor {
  readonly commands: string[] = [];
  readonly uploads: Array<{ localPath: string; remotePath: string }> = [];
  readonly downloads: Array<{ remotePath: string; localPath: string }> = [];
  private readonly results = new Map<string, Partial<ExecResult>>();

  when(command: string, result: Partial<ExecResult>): this {
    this.results.set(command, result);
    return this;
  }

  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    const override = this.results.get(command);
    return {
      command,
      stdout: override?.stdout ?? "",
      stderr: override?.stderr ?? "",
      code: override?.code ?? 0
    };
  }

  async upload(localPath: string, remotePath: string): Promise<UploadResult> {
    this.uploads.push({ localPath, remotePath });
    return { localPath, remotePath, bytes: 42 };
  }

  async download(remotePath: string, localPath: string): Promise<DownloadResult> {
    this.downloads.push({ remotePath, localPath });
    return { remotePath, localPath, bytes: 42 };
  }

  close(): void {
    // no-op
  }
}
