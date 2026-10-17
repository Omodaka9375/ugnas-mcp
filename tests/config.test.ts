import { afterEach, describe, expect, it } from "vitest";

import { applyEnvOverrides, loadNasConfig, parseNasConfig } from "../src/config.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

describe("parseNasConfig", () => {
  it("applies defaults without inventing target facts", () => {
    const config = parseNasConfig({
      host: "nas.local",
      username: "admin",
      auth: { type: "password", password: "secret" }
    });
    expect(config.port).toBe(22);
    expect(config.defaultShare).toBe("/volume1");
    expect(config.commandTimeoutMs).toBe(60_000);
    expect(config.name).toBe("default");
  });

  it("rejects a config with no host", () => {
    expect(() =>
      parseNasConfig({ username: "admin", auth: { type: "password", password: "x" } })
    ).toThrow();
  });

  it("rejects key auth without a key path", () => {
    expect(() =>
      parseNasConfig({ host: "nas.local", username: "admin", auth: { type: "key" } })
    ).toThrow();
  });
});

describe("applyEnvOverrides", () => {
  const env = process.env;
  afterEach(() => {
    process.env = { ...env };
  });

  it("lets environment variables win and build auth", () => {
    process.env = {
      ...env,
      UGNAS_HOST: "10.0.0.5",
      UGNAS_USER: "ops",
      UGNAS_AUTH_TYPE: "password",
      UGNAS_PASSWORD: "pw"
    };
    const merged = applyEnvOverrides({ host: "old", username: "old", auth: { type: "password", password: "old" } });
    expect(merged.host).toBe("10.0.0.5");
    expect(merged.username).toBe("ops");
    expect(merged.auth).toEqual({ type: "password", password: "pw" });
  });
});

describe("loadNasConfig", () => {
  it("reads a config file and resolves inline key material", () => {
    const dir = mkdtempSync(join(tmpdir(), "ugnas-"));
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        host: "nas.local",
        username: "admin",
        auth: { type: "key", privateKeyPath: PEM }
      })
    );

    try {
      const resolved = loadNasConfig(configPath);
      expect(resolved.host).toBe("nas.local");
      expect(resolved.auth.type).toBe("key");
      if (resolved.auth.type === "key") {
        expect(resolved.auth.privateKey.toString("utf8")).toContain("BEGIN OPENSSH PRIVATE KEY");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
