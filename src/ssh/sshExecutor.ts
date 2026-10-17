import { Client, type ConnectConfig } from "ssh2";

import type { ResolvedNasConfig } from "../config.js";

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

  constructor(config: ResolvedNasConfig) {
    this.config = config;
    this.client = new Client();
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const connectConfig: ConnectConfig = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      readyTimeout: this.config.commandTimeoutMs,
      ...(this.config.auth.type === "key"
        ? { privateKey: this.config.auth.privateKey, passphrase: this.config.auth.passphrase }
        : { password: this.config.auth.password })
    };

    if (this.config.hostKeySha256) {
      connectConfig.hostHash = "sha256";
      connectConfig.hostVerifier = (hashedKey: string): boolean => {
        return `SHA256:${hashedKey}` === this.config.hostKeySha256;
      };
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.connected = true;
        resolve();
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`SSH connection to ${this.config.host}:${this.config.port} failed: ${error.message}`));
      };
      const cleanup = () => {
        this.client.removeListener("ready", onReady);
        this.client.removeListener("error", onError);
      };
      this.client.once("ready", onReady);
      this.client.once("error", onError);
      this.client.connect(connectConfig);
    });
  }

  async exec(command: string): Promise<ExecResult> {
    await this.connect();
    return new Promise<ExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${this.config.commandTimeoutMs}ms: ${command}`));
      }, this.config.commandTimeoutMs);

      this.client.exec(command, (error, stream) => {
        if (error) {
          clearTimeout(timer);
          reject(new Error(`Failed to run command over SSH: ${error.message}`));
          return;
        }

        let stdout = "";
        let stderr = "";
        stream.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ command, stdout, stderr, code: code ?? 0 });
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
