import { describe, expect, it } from "vitest";

import type { ResolvedNasConfig } from "../src/config.js";
import type { ServiceContext } from "../src/services/context.js";
import { DockerService } from "../src/services/dockerService.js";
import { FileService } from "../src/services/fileService.js";
import { SystemService } from "../src/services/systemService.js";
import { deterministicService, FakeExecutor } from "./helpers.js";

function makeContext(executor: FakeExecutor): ServiceContext {
  const config: ResolvedNasConfig = {
    name: "test",
    host: "nas.local",
    port: 22,
    username: "admin",
    auth: { type: "password", password: "x" },
    defaultShare: "/volume1",
    commandTimeoutMs: 5000
  };
  return {
    executor,
    config,
    confirmations: deterministicService() as unknown as ServiceContext["confirmations"]
  };
}

describe("dry-run safety gate", () => {
  it("returns a plan and runs nothing without a token", async () => {
    const executor = new FakeExecutor();
    const docker = new DockerService(makeContext(executor));

    const outcome = await docker.restartContainer("web");

    expect(outcome).toMatchObject({ dryRun: true, requiresConfirmation: true, action: "docker.containers.restart" });
    expect(executor.commands).toEqual([]);
  });

  it("executes exactly the planned command when a token is supplied", async () => {
    const executor = new FakeExecutor();
    const docker = new DockerService(makeContext(executor));

    const plan = await docker.restartContainer("web");
    if (!("confirmationToken" in plan)) {
      throw new Error("expected a dry-run plan");
    }

    const executed = await docker.restartContainer("web", plan.confirmationToken);

    expect(executed).toMatchObject({ executed: true });
    expect(executor.commands).toEqual(["docker restart 'web'"]);
  });

  it("quotes container names so shell metacharacters cannot escape", async () => {
    const executor = new FakeExecutor();
    const docker = new DockerService(makeContext(executor));
    const plan = await docker.removeContainer({ nameOrId: "x; rm -rf /" });
    if (!("commands" in plan)) {
      throw new Error("expected a plan");
    }
    expect(plan.commands[0]).toBe("docker rm 'x; rm -rf /'");
  });
});

describe("file transfers are gated the same way", () => {
  it("does not touch SFTP without a token", async () => {
    const executor = new FakeExecutor();
    const files = new FileService(makeContext(executor));

    const outcome = await files.upload({ localPath: "C:/tmp/a.iso", remotePath: "media/a.iso" });

    expect(outcome).toMatchObject({ dryRun: true, requiresConfirmation: true });
    expect(executor.uploads).toEqual([]);
    expect(outcome).toHaveProperty("summary", expect.stringContaining("/volume1/media/a.iso"));
  });

  it("performs the transfer once confirmed", async () => {
    const executor = new FakeExecutor();
    const files = new FileService(makeContext(executor));

    const plan = await files.upload({ localPath: "C:/tmp/a.iso", remotePath: "media/a.iso" });
    if (!("confirmationToken" in plan)) {
      throw new Error("expected a plan");
    }

    const executed = await files.upload({
      localPath: "C:/tmp/a.iso",
      remotePath: "media/a.iso",
      token: plan.confirmationToken
    });

    expect(executed).toMatchObject({ executed: true, transfer: { direction: "upload", bytes: 42 } });
    expect(executor.uploads).toEqual([{ localPath: "C:/tmp/a.iso", remotePath: "/volume1/media/a.iso" }]);
  });
});

describe("files.sync", () => {
  it("gates the rsync run behind a token and preserves trailing-slash semantics", async () => {
    const executor = new FakeExecutor();
    executor.when("command -v rsync >/dev/null 2>&1 && echo yes || echo no", { stdout: "yes" });
    const files = new FileService(makeContext(executor));

    const plan = await files.sync({ source: "media/", destination: "backup/media" });
    if (!("confirmationToken" in plan)) {
      throw new Error("expected a plan");
    }

    expect(executor.commands).toEqual(["command -v rsync >/dev/null 2>&1 && echo yes || echo no"]);
    expect(plan.commands[0]).toContain("'/volume1/media/'");
    expect(plan.commands[0]).toContain("'/volume1/backup/media'");

    const executed = await files.sync({
      source: "media/",
      destination: "backup/media",
      token: plan.confirmationToken
    });

    expect(executed).toMatchObject({ executed: true });
    expect(executor.commands[1]).toContain("rsync");
  });

  it("warns when the mirror (--delete) flag is used", async () => {
    const executor = new FakeExecutor();
    executor.when("command -v rsync >/dev/null 2>&1 && echo yes || echo no", { stdout: "yes" });
    const files = new FileService(makeContext(executor));

    const plan = await files.sync({ source: "a", destination: "b", delete: true });
    if (!("warnings" in plan)) {
      throw new Error("expected a plan");
    }
    expect(plan.warnings.join(" ")).toMatch(/--delete removes files/);
  });

  it("refuses by default when rsync is missing, and notes how to opt in", async () => {
    const executor = new FakeExecutor();
    executor.when("command -v rsync >/dev/null 2>&1 && echo yes || echo no", { stdout: "no" });
    const files = new FileService(makeContext(executor));

    const plan = await files.sync({ source: "a", destination: "b" });
    if (!("confirmationToken" in plan)) {
      throw new Error("expected a plan");
    }

    expect(plan.commands[0]).toMatch(/^rsync /);
    expect(plan.payload.usedEngine).toBe("rsync");
    expect(plan.note).toMatch(/install it|cop fallback|fallback:"cp"/);
  });

  it("uses the cp fallback when rsync is missing and fallback:'cp'", async () => {
    const executor = new FakeExecutor();
    executor.when("command -v rsync >/dev/null 2>&1 && echo yes || echo no", { stdout: "no" });
    const files = new FileService(makeContext(executor));

    const plan = await files.sync({ source: "media/", destination: "backup/media", fallback: "cp" });
    if (!("confirmationToken" in plan)) {
      throw new Error("expected a plan");
    }

    expect(plan.payload.usedEngine).toBe("cp");
    expect(plan.commands[0]).toBe("mkdir -p '/volume1/backup/media/' && cp -a '/volume1/media/.' '/volume1/backup/media/'");
    expect(plan.note).toMatch(/cp -a` fallback/);
  });

  it("flags unsupported options when the cp fallback is used", async () => {
    const executor = new FakeExecutor();
    executor.when("command -v rsync >/dev/null 2>&1 && echo yes || echo no", { stdout: "no" });
    const files = new FileService(makeContext(executor));

    const plan = await files.sync({
      source: "a",
      destination: "b",
      delete: true,
      dryRun: true,
      extraArgs: ["--exclude", "*.tmp"],
      fallback: "cp"
    });
    if (!("warnings" in plan)) {
      throw new Error("expected a plan");
    }
    const joined = plan.warnings.join(" ");
    expect(joined).toMatch(/cannot mirror/);
    expect(joined).toMatch(/does not support rsync --dry-run/);
    expect(joined).toMatch(/ignores extraArgs/);
  });
});

describe("system.pools", () => {
  it("parses mdadm arrays and degradation from a combined marker output", async () => {
    const executor = new FakeExecutor();
    const service = new SystemService(makeContext(executor));

    // First call captures the exact combined command the service issues.
    await service.pools().catch(() => undefined);
    const command = executor.commands[executor.commands.length - 1] ?? "";

    const mdstat = [
      "Personalities : [raid1] [raid6]",
      "md0 : active raid1 sda1[0] sdb1[1]",
      "      1953382400 blocks [2/2] [UU]",
      "md1 : active raid6 sdc1[0] sdd1[1](F) sde1[2]",
      "      3906764800 blocks [3/3] [UU_]"
    ].join("\n");

    executor.when(command, {
      stdout: [
        "###MDSTAT###",
        mdstat,
        "###LVM###",
        "",
        "###BTRFS###",
        "",
        "###LSBLK###",
        "NAME   SIZE TYPE FSTYPE MOUNTPOINT MODEL",
        "sda    2T   disk",
        "",
        "###BLKID###",
        '/dev/sda1: UUID="abc" TYPE="ext4"'
      ].join("\n")
    });

    const pools = await service.pools();

    expect(pools.mdstat).toHaveLength(2);
    expect(pools.mdstat[0]).toMatchObject({ name: "md0", level: "raid1", members: ["sda1", "sdb1"] });
    expect(pools.mdstat[1]).toMatchObject({ name: "md1", degraded: true });
    expect(pools.blockDevices[0]).toMatchObject({ name: "sda", size: "2T", type: "disk" });
    expect(pools.filesystems[0]).toMatchObject({ device: "/dev/sda1", uuid: "abc", type: "ext4" });
  });
});

describe("read parsing", () => {
  it("parses system.info from a combined marker output", async () => {
    const executor = new FakeExecutor();
    executor.when(
      (await expectedInfoCommand(executor)),
      {
        stdout: [
          "###OS_RELEASE###",
          'NAME="UGOS"',
          "VERSION=2.0",
          "###CPU###",
          "8",
          "###LOAD###",
          "0.10 0.20 0.30 1/100 42",
          "###MEM###",
          "MemTotal:       8000000 kB",
          "MemAvailable:   6000000 kB",
          "###UPTIME###",
          "up 3 days",
          "###TEMP###",
          "/sys/class/thermal/thermal_zone0/temp=45000",
          "###DISK###",
          "Filesystem Size Used Avail Use% Mounted on",
          "/dev/sda1  100G  40G  60G  40% /volume1",
          "###DOCKER###",
          "Docker version 27.0.0, build abc"
        ].join("\n")
      }
    );

    const info = await new SystemService(makeContext(executor)).info();

    expect(info.cpuCoreCount).toBe(8);
    expect(info.memoryTotalKb).toBe(8000000);
    expect(info.temperatureCelsius["/sys/class/thermal/thermal_zone0/temp"]).toBe(45);
    expect(info.disks[0]).toMatchObject({ filesystem: "/dev/sda1", mountedOn: "/volume1" });
    expect(info.dockerVersion).toContain("Docker version");
  });

  it("lists directories including names with spaces", async () => {
    const executor = new FakeExecutor();
    executor.when("ls -la --time-style=long-iso '/volume1/media' 2>&1 || true", {
      stdout: [
        "total 8",
        "drwxr-xr-x 2 root root 4096 2024-01-02 03:04 my folder",
        "-rw-r--r-- 1 root root  123 2024-01-02 03:05 movie.mkv"
      ].join("\n")
    });

    const listing = await new FileService(makeContext(executor)).list("media");

    expect(listing.path).toBe("/volume1/media");
    expect(listing.entries).toHaveLength(2);
    expect(listing.entries[0]).toMatchObject({ name: "my folder", type: "dir" });
    expect(listing.entries[1]).toMatchObject({ name: "movie.mkv", type: "file", sizeBytes: 123 });
  });
});

/** Build the exact system.info command string used by the service. */
async function expectedInfoCommand(executor: FakeExecutor): Promise<string> {
  await new SystemService(makeContext(executor)).info().catch(() => undefined);
  return executor.commands[executor.commands.length - 1] ?? "";
}
