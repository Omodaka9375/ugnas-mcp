import { randomUUID } from "node:crypto";

/** A description of a mutating action, produced BEFORE anything is executed. */
export type PlannedAction = {
  action: string;
  summary: string;
  requiresConfirmation: true;
  dryRun: boolean;
  commands: string[];
  warnings: string[];
  /** Optional user-facing hint, e.g. how to enable an opt-in behavior. */
  note?: string;
  payload: Record<string, unknown>;
};

export type IssuedConfirmation = {
  token: string;
  action: string;
  summary: string;
  expiresAt: string;
};

export type PendingConfirmation = IssuedConfirmation & {
  payload: Record<string, unknown>;
};

export type PlanResult = PlannedAction & {
  confirmationToken: string;
  expiresAt: string;
};

export type ExecutedCommand = {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
};

export type ExecutionResult = {
  executed: true;
  action: string;
  results: ExecutedCommand[];
  transfer?: {
    direction: "upload" | "download";
    localPath: string;
    remotePath: string;
    bytes: number;
  };
};

export function stringArrayFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Commands captured at plan time — executed verbatim so intent cannot drift. */
export function commandsFromPending(pending: PendingConfirmation): string[] {
  return stringArrayFrom(pending.payload.__commands);
}

export class ConfirmationTokenService {
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly generate: () => string;

  constructor(input?: { now?: () => Date; ttlMs?: number; generate?: () => string }) {
    this.now = input?.now ?? (() => new Date());
    this.ttlMs = input?.ttlMs ?? 10 * 60 * 1000;
    this.generate = input?.generate ?? (() => randomUUID());
  }

  issue(plan: PlannedAction): PlanResult {
    const issuedAt = this.now();
    const token = this.generate();
    const expiresAt = new Date(issuedAt.getTime() + this.ttlMs).toISOString();

    this.pending.set(token, {
      token,
      action: plan.action,
      summary: plan.summary,
      expiresAt,
      payload: { ...plan.payload, __commands: plan.commands }
    });

    return { ...plan, confirmationToken: token, expiresAt };
  }

  /** Validate and single-use consume a token, returning the stored payload. */
  consume(token: string, expectedAction?: string): PendingConfirmation {
    const pending = this.pending.get(token);
    if (!pending) {
      throw new Error(
        "Unknown or already-used confirmation token. Re-run the tool to obtain a fresh dry-run plan."
      );
    }

    if (this.now().toISOString() > pending.expiresAt) {
      this.pending.delete(token);
      throw new Error("Confirmation token has expired. Re-run the tool for a fresh plan.");
    }

    if (expectedAction && pending.action !== expectedAction) {
      throw new Error(
        `Confirmation token was issued for "${pending.action}" but used for "${expectedAction}".`
      );
    }

    this.pending.delete(token);
    return pending;
  }
}
