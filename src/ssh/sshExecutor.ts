import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

import type { ResolvedNasConfig } from "../config.js";

/**
 * Build the ssh2 connect config for a resolved NAS config (pinned host key
 * fingerprints are compared padding-stripped, matching `ssh-keygen -lf`).
 */
function connectConfigFor(config: ResolvedNasConfig): ConnectConfig {
  const connectConfig: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: config.commandTimeoutMs,
    ...(config.auth.type === "key"
      ? { privateKey: config.auth.privateKey, passphrase: config.auth.passphrase }
      : { password: config.auth.password })
  };

  if (config.hostKeySha256) {
    connectConfig.hostHash = "sha256";
    connectConfig.hostVerifier = (hashedKey: string): boolean => {
      // ssh2 hands us a base64 digest that may carry padding; fingerprints
      // printed by `ssh-keygen -lf` (what users paste) do not. Normalize both.
      const normalize = (value: string) => value.replace(/=+$/, "");
      return normalize(`SHA256:${hashedKey}`) === normalize(config.hostKeySha256 ?? "");
    };
  }

  return connectConfig;
}

export type ExecResult = {
  command: string;
  stdout: string;
  stderr: string;
  code: number;
};

export type UploadResult = {
  localPath: string;
  remotePath: string;
  bytes: number;
};

export type DownloadResult = {
  remotePath: string;
  localPath: string;
  bytes: number;
};

/**
 * Narrow surface the rest of the app depends on. Keeping it small lets services
 * run against a fake in tests without opening a real SSH connection.
 */
export interface CommandExecutor {
  exec(command: string): Promise<ExecResult>;
  upload(localPath: string, remotePath: string): Promise<UploadResult>;
  download(remotePath: string, localPath: string): Promise<DownloadResult>;
  close(): void;
}

export class SshExecutor implements CommandExecutor {
  private readonly client: Client;
  private readonly config: ResolvedNasConfig;
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(config: ResolvedNasConfig) {
    this.config = config;
    this.client = new Client();

    // Persistent handlers: a dropped connection must reset `connected` (not
    // crash the process as an unhandled "error" event) so the next call
    // reconnects instead of hanging until the per-command timeout.
    this.client.on("close", () => {
      this.connected = false;
      this.connecting = null;
    });
    this.client.on("error", (error: Error) => {
      if (this.connected) {
        this.connected = false;
        this.connecting = null;
        process.stderr.write(`ugnas-mcp: SSH connection lost: ${error.message}\n`);
      }
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    // Cache the in-flight promise so concurrent tool calls can't double-connect
    // (ssh2 throws "connect() already called" for a second connect).
    this.connecting ??= new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        this.connected = true;
        this.connecting = null;
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        this.connecting = null;
        reject(
          new Error(
            `SSH connection to ${this.config.host}:${this.config.port} failed: ${error.message}`
          )
        );
      };
      const cleanup = () => {
        this.client.removeListener("ready", onReady);
        this.client.removeListener("error", onError);
      };
      // The persistent "error" handler added in the constructor covers
      // post-ready errors; these once-handlers cover the connect phase only.
      this.client.once("ready", onReady);
      this.client.once("error", onError);
      this.client.connect(connectConfigFor(this.config));
    });
    return this.connecting;
  }

  async exec(command: string): Promise<ExecResult> {
    await this.connect();
    return new Promise<ExecResult>((resolve, reject) => {
      let stream: ClientChannel | null = null;
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        // Kill the remote command and close the channel so a timeout does not
        // leak an exec channel (the op may still run to completion server-side
        // — surface that in the error message).
        stream?.signal?.("KILL");
        stream?.close();
        settle(() =>
          reject(
            new Error(
              `Command timed out after ${this.config.commandTimeoutMs}ms (the remote operation may still be running): ${command}`
            )
          )
        );
      }, this.config.commandTimeoutMs);

      this.client.exec(command, (error, s) => {
        if (error) {
          settle(() => reject(new Error(`Failed to run command over SSH: ${error.message}`)));
          return;
        }
        stream = s;

        let stdout = "";
        let stderr = "";
        s.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        s.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        s.on("error", (streamError: Error) => {
          settle(() => reject(new Error(`Command over SSH failed: ${streamError.message}`)));
        });
        s.on("close", (code: number | null) => {
          settle(() => resolve({ command, stdout, stderr, code: code ?? 0 }));
        });
      });
    });
  }

  async upload(localPath: string, remotePath: string): Promise<UploadResult> {
    await this.connect();
    return new Promise<UploadResult>((resolve, reject) => {
      this.client.sftp((error, sftp) => {
        if (error) {
          reject(new Error(`Failed to open SFTP channel: ${error.message}`));
          return;
        }
        let bytes = 0;
        sftp.fastPut(localPath, remotePath, (putError) => {
          if (putError) {
            reject(new Error(`Upload to ${remotePath} failed: ${putError.message}`));
            return;
          }
          sftp.stat(remotePath, (statError, stats) => {
            if (!statError && stats) {
              bytes = stats.size;
            }
            sftp.end();
            resolve({ localPath, remotePath, bytes });
          });
        });
      });
    });
  }

  async download(remotePath: string, localPath: string): Promise<DownloadResult> {
    await this.connect();
    return new Promise<DownloadResult>((resolve, reject) => {
      this.client.sftp((error, sftp) => {
        if (error) {
          reject(new Error(`Failed to open SFTP channel: ${error.message}`));
          return;
        }
        let bytes = 0;
        sftp.stat(remotePath, (statError, stats) => {
          if (!statError && stats) {
            bytes = stats.size;
          }
          sftp.fastGet(remotePath, localPath, (getError) => {
            if (getError) {
              reject(new Error(`Download from ${remotePath} failed: ${getError.message}`));
              return;
            }
            sftp.end();
            resolve({ remotePath, localPath, bytes });
          });
        });
      });
    });
  }

  close(): void {
    this.client.end();
    this.connected = false;
  }
}
