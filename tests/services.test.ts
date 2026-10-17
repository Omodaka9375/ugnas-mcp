import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ResolvedNasConfig } from "../src/config.js";
import type { ServiceContext } from "../src/services/context.js";
import { DockerService } from "../src/services/dockerService.js";
import { FileService } from "../src/services/fileService.js";
import { SystemService } from "../src/services/systemService.js";
import { toSftpPath } from "../src/services/util.js";
import { deterministicService, FakeExecutor } from "./helpers.js";

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
    // The transfer reports the exec path, but SFTP receives the chroot-relative path.
    expect(executed).toMatchObject({ transfer: { remotePath: "/volume1/media/a.iso" } });
    expect(executor.uploads).toEqual([{ localPath: "C:/tmp/a.iso", remotePath: "/media/a.iso" }]);
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

describe("files.find", () => {
  it("parses find output, filters by extension, and reports sizes", async () => {
    const executor = new FakeExecutor();
    const files = new FileService(makeContext(executor));

    // Capture the exact find command, then answer it.
    await files.find({ path: "media" }).catch(() => undefined);
    const command = executor.commands[executor.commands.length - 1] ?? "";
    executor.when(command, {
      stdout: [
        "1048576\t1700000000\t/volume1/media/movie.mkv",
        "2048\t1700000100\t/volume1/media/note.txt",
        "4096\t1700000200\t/volume1/media/clip.MP4"
      ].join("\n")
    });

    const all = await files.find({ path: "media" });
    expect(all.count).toBe(3);
    expect(all.entries[0]).toMatchObject({ name: "movie.mkv", sizeBytes: 1048576, sizeHuman: "1.0 MB", extension: "mkv" });

    const videos = await files.find({ path: "media", extensions: ["mp4", ".mkv"] });
    expect(videos.count).toBe(2);
    expect(videos.entries.map((e) => e.extension).sort()).toEqual(["mkv", "mp4"]);
  });

  it("filters by name glob and honours the limit", async () => {
    const executor = new FakeExecutor();
    const files = new FileService(makeContext(executor));
    await files.find({ path: "media" }).catch(() => undefined);
    const command = executor.commands[executor.commands.length - 1] ?? "";
    executor.when(command, {
      stdout: [
        "10\t1700000000\t/volume1/media/IMG_2024_a.jpg",
        "10\t1700000000\t/volume1/media/IMG_2024_b.jpg",
        "10\t1700000000\t/volume1/media/other.jpg"
      ].join("\n")
    });

    const result = await files.find({ path: "media", name: "IMG_2024*", limit: 1 });
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("IMG_2024_a.jpg");
  });
});

describe("files.thumbnail", () => {
  it("generates via ffmpeg, fetches bytes over exec (base64), and cleans up", async () => {
    const executor = new FakeExecutor();
    executor.when("command -v 'ffmpeg' >/dev/null 2>&1 && echo yes || echo no", { stdout: "yes" });
    // The base64 read returns a small known payload.
    const payload = Buffer.from("fake-jpeg-bytes").toString("base64");
    const files = new FileService(makeContext(executor));

    // Intercept the base64 read; everything else goes to the fake.
    const origExec = executor.exec.bind(executor);
    executor.exec = async (command: string) => {
      if (command.startsWith("base64 ")) {
        return { command, stdout: payload, stderr: "", code: 0 };
      }
      return origExec(command);
    };

    const dir = mkdtempSync(join(tmpdir(), "ugnas-thumb-"));
    const out = join(dir, "thumb.jpg");
    try {
      const result = await files.thumbnail({
        path: "media/movie.mkv",
        localPath: out,
        width: 320,
        time: "00:00:05"
      });

      expect(result).toMatchObject({ kind: "video", width: 320, engine: "ffmpeg" });
      expect(result.bytes).toBe(Buffer.from("fake-jpeg-bytes").length);
      expect(readFileSync(out, "utf8")).toBe("fake-jpeg-bytes");

      const ffmpegCmd = executor.commands.find((c) => c.startsWith("ffmpeg"));
      expect(ffmpegCmd).toContain("-ss '00:00:05'");
      expect(ffmpegCmd).toContain("'scale=320:-2'");
      expect(ffmpegCmd).toContain("'/volume1/media/movie.mkv'");

      const cleanup = executor.commands.find((c) => c.startsWith("rm -f "));
      expect(cleanup).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when ffmpeg is missing", async () => {
    const executor = new FakeExecutor();
    executor.when("command -v 'ffmpeg' >/dev/null 2>&1 && echo yes || echo no", { stdout: "no" });
    const files = new FileService(makeContext(executor));

    await expect(files.thumbnail({ path: "photos/a.jpg", localPath: "C:/tmp/a.jpg" })).rejects.toThrow(/ffmpeg/);
  });
});

describe("SFTP path mapping", () => {
  it("strips the share root for chrooted SFTP", () => {
    const config = makeContext(new FakeExecutor()).config;
    expect(toSftpPath(config, "/volume1/docker/x.iso")).toBe("/docker/x.iso");
    expect(toSftpPath(config, "/volume1")).toBe("/");
    expect(toSftpPath(config, "/elsewhere/y")).toBe("/elsewhere/y");
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
