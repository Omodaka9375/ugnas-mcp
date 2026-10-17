import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

/**
 * Everything target-specific lives in user config. There are intentionally NO
 * default hostnames, subnets, usernames, or share paths anywhere in this file.
 */

const keyAuthSchema = z.object({
  type: z.literal("key"),
  privateKeyPath: z.string().min(1, "auth.privateKeyPath is required for key auth"),
  passphrase: z.string().optional()
});

const passwordAuthSchema = z.object({
  type: z.literal("password"),
  password: z.string().min(1, "auth.password is required for password auth")
});

export const nasConfigSchema = z.object({
  name: z.string().min(1).default("default"),
  host: z.string().min(1, "host is required"),
  port: z.number().int().positive().max(65535).default(22),
  username: z.string().min(1, "username is required"),
  auth: z.discriminatedUnion("type", [keyAuthSchema, passwordAuthSchema]),
  /** Base directory used to resolve relative share paths (e.g. "/volume1"). */
  defaultShare: z.string().min(1).default("/volume1"),
  /** Optional pinned host key fingerprint (SHA256:...). When set, it is enforced. */
  hostKeySha256: z.string().optional(),
  /** Command execution timeout in milliseconds. */
  commandTimeoutMs: z.number().int().positive().default(60_000)
});

export type NasConfig = z.infer<typeof nasConfigSchema>;

export type ResolvedNasConfig = Omit<NasConfig, "auth" | "defaultShare"> & {
  auth:
    | { type: "key"; privateKey: Buffer; passphrase?: string }
    | { type: "password"; password: string };
  defaultShare: string;
};

export function defaultConfigPath(): string {
  return process.env.UGNAS_MCP_CONFIG ?? path.join(os.homedir(), ".ugnas-mcp", "config.json");
}

export function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/** Merge env-var overrides on top of a parsed file object (env wins for secrets). */
export function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  const env = process.env;
  const merged: Record<string, unknown> = { ...raw };

  if (env.UGNAS_HOST) merged.host = env.UGNAS_HOST;
  if (env.UGNAS_PORT) merged.port = Number(env.UGNAS_PORT);
  if (env.UGNAS_USER) merged.username = env.UGNAS_USER;
  if (env.UGNAS_DEFAULT_SHARE) merged.defaultShare = env.UGNAS_DEFAULT_SHARE;
  if (env.UGNAS_HOST_KEY_SHA256) merged.hostKeySha256 = env.UGNAS_HOST_KEY_SHA256;

  const authType = env.UGNAS_AUTH_TYPE;
  if (authType === "key" || env.UGNAS_KEY_PATH) {
    merged.auth = {
      type: "key",
      privateKeyPath: env.UGNAS_KEY_PATH,
      passphrase: env.UGNAS_KEY_PASSPHRASE
    };
  } else if (authType === "password" || env.UGNAS_PASSWORD) {
    merged.auth = { type: "password", password: env.UGNAS_PASSWORD };
  }

  return merged;
}

export function parseNasConfig(raw: unknown): NasConfig {
  return nasConfigSchema.parse(raw);
}

export function loadRawConfig(configPath = defaultConfigPath()): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read UGREEN NAS config at ${configPath}: ${reason}. ` +
        `Create it (see README) or set UGNAS_MCP_CONFIG / UGNAS_* environment variables.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`UGREEN NAS config at ${configPath} is not valid JSON: ${reason}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`UGREEN NAS config at ${configPath} must be a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

/** Fully load + validate config, resolving auth material and paths to absolute values. */
export function loadNasConfig(configPath = defaultConfigPath()): ResolvedNasConfig {
  const config = parseNasConfig(applyEnvOverrides(loadRawConfig(configPath)));

  const auth: ResolvedNasConfig["auth"] =
    config.auth.type === "key"
      ? {
          type: "key",
          privateKey: readKeyMaterial(config.auth.privateKeyPath),
          passphrase: config.auth.passphrase
        }
      : { type: "password", password: config.auth.password };

  return {
    ...config,
    defaultShare: config.defaultShare,
    auth
  };
}

function readKeyMaterial(privateKeyPath: string): Buffer {
  const resolved = expandHome(privateKeyPath);

  // A raw key may be supplied inline (contains a PEM header) or as a path.
  if (resolved.includes("-----BEGIN")) {
    return Buffer.from(resolved, "utf8");
  }

  try {
    return readFileSync(resolved);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read SSH private key at ${resolved}: ${reason}`);
  }
}
