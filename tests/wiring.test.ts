import { describe, expect, it } from "vitest";

import { registerTools } from "../src/mcp/toolset.js";
import type { ServiceContext } from "../src/services/context.js";
import { BackupService } from "../src/services/backupService.js";
import { DockerService } from "../src/services/dockerService.js";
import { FileService } from "../src/services/fileService.js";
import { NetworkService } from "../src/services/networkService.js";
import { SystemService } from "../src/services/systemService.js";
import { ConfirmationTokenService } from "../src/safety/plan.js";
import type { ResolvedNasConfig } from "../src/config.js";
import { FakeExecutor } from "./helpers.js";

function makeContext(executor: FakeExecutor): ServiceContext {
  const config: ResolvedNasConfig = {
    name: "test",
    host: "nas.local",
    port: 22,
    username: "admin",
    auth: { type: "password", password: "x" },
    defaultShare: "/volume1",
    sftpRoot: "/volume1",
    commandTimeoutMs: 5000
  };
  return { executor, config, confirmations: new ConfirmationTokenService() };
}

/** A minimal McpServer stand-in: registerTools only calls registerTool(name, …). */
class ToolNameRecorder {
  readonly toolNames: string[] = [];
  registerTool(name: string): void {
    this.toolNames.push(name);
  }
}

/**
 * The wiring contract: every tool name registered by registerTools, and the
 * service methods each tool must dispatch to. If a service method gains or
 * loses a tool (or vice versa), these lists drift and the test fails — which
 * is exactly how dead methods went unnoticed before.
 */
const EXPECTED_TOOLS_BY_METHOD: Record<string, string[]> = {
  system: ["system.status", "system.info", "system.pools"],
  docker: [
    "docker.containers.list",
    "docker.containers.inspect",
    "docker.containers.logs",
    "docker.containers.start",
    "docker.containers.stop",
    "docker.containers.restart",
    "docker.containers.remove",
    "docker.images.list",
    "docker.images.pull",
    "docker.images.remove",
    "docker.networks.list",
    "docker.networks.inspect",
    "docker.networks.create",
    "docker.networks.remove",
    "docker.networks.connect",
    "docker.networks.disconnect",
    "docker.compose"
  ],
  files: [
    "files.list",
    "files.usage",
    "files.find",
    "files.thumbnail",
    "files.mkdir",
    "files.copy",
    "files.move",
    "files.remove",
    "files.upload",
    "files.download",
    "files.sync"
  ],
  backup: ["backup.create", "backup.list", "backup.verify", "backup.restore", "backup.schedule"],
  network: ["network.interfaces", "network.routes", "network.ports"]
};

/** Tool-facing method name shape (excludes mangled/private helpers). */
const TOOL_FACING = /^[a-z][A-Za-z0-9]*$/;

const EXPECTED_METHODS: Record<string, string[]> = {
  system: ["status", "info", "pools"],
  docker: [
    "containerAction",
    "listContainers",
    "inspectContainer",
    "containerLogs",
    "startContainer",
    "stopContainer",
    "restartContainer",
    "removeContainer",
    "listImages",
    "pullImage",
    "removeImage",
    "listNetworks",
    "inspectNetwork",
    "createNetwork",
    "removeNetwork",
    "connectNetwork",
    "disconnectNetwork",
    "compose"
  ],
  files: [
    "list",
    "find",
    "thumbnail",
    "usage",
    "makeDirectory",
    "copy",
    "move",
    "remove",
    "upload",
    "download",
    "sync"
  ],
  backup: ["create", "list", "verify", "restore", "schedule"],
  network: ["interfaces", "routes", "listeningPorts"]
};

describe("service <-> tool wiring", () => {
  it("registers exactly the expected tool set (no missing, no extra)", () => {
    const recorder = new ToolNameRecorder();
    registerTools(
      recorder as unknown as Parameters<typeof registerTools>[0],
      makeContext(new FakeExecutor())
    );

    const expected = Object.values(EXPECTED_TOOLS_BY_METHOD).flat().sort();
    expect(recorder.toolNames.sort()).toEqual(expected);
    expect(recorder.toolNames).toHaveLength(39);
  });

  it("every expected service method exists on its class (and no extras)", () => {
    const ctx = makeContext(new FakeExecutor());
    const services: Record<string, object> = {
      system: new SystemService(ctx),
      docker: new DockerService(ctx),
      files: new FileService(ctx),
      backup: new BackupService(ctx),
      network: new NetworkService(ctx)
    };

    for (const [name, service] of Object.entries(services)) {
      const expected = EXPECTED_METHODS[name] ?? [];

      // Every contract method must exist as a function on the class...
      for (const method of expected) {
        expect(
          typeof (service as Record<string, unknown>)[method],
          `${name}.${method} must be a function`
        ).toBe("function");
      }

    }
  });

  it("each tool's input schema gates mutating tools with a confirmToken field", () => {
    const registrations: Array<{ name: string; config: { inputSchema?: Record<string, unknown> } }> = [];
    const recorder = {
      registerTool(name: string, config: { inputSchema?: Record<string, unknown> }) {
        registrations.push({ name, config });
      }
    };

    registerTools(
      recorder as unknown as Parameters<typeof registerTools>[0],
      makeContext(new FakeExecutor())
    );

    const mutating = new Set([
      "docker.containers.start",
      "docker.containers.stop",
      "docker.containers.restart",
      "docker.containers.remove",
      "docker.images.pull",
      "docker.images.remove",
      "docker.networks.create",
      "docker.networks.remove",
      "docker.networks.connect",
      "docker.networks.disconnect",
      "docker.compose",
      "files.thumbnail",
      "files.mkdir",
      "files.copy",
      "files.move",
      "files.remove",
      "files.upload",
      "files.download",
      "files.sync",
      "backup.create",
      "backup.restore",
      "backup.schedule"
    ]);

    for (const { name, config } of registrations) {
      const hasTokenField = Boolean(config.inputSchema && "confirmToken" in config.inputSchema);
      expect(
        hasTokenField,
        `${name} confirmToken field presence must match its mutating status`
      ).toBe(mutating.has(name));
    }
  });
});