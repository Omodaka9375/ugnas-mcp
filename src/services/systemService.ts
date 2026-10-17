import type { ServiceContext } from "./context.js";
import { execChecked, parseSections, sectionCommand } from "./util.js";

export type SystemStatus = {
  reachable: boolean;
  host: string;
  hostname: string;
  platform: string;
  kernel: string;
  uptime: string;
  dockerInstalled: boolean;
  dockerVersion: string | null;
};

export type DiskEntry = {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  usePercent: string;
  mountedOn: string;
};

export type MdArray = {
  name: string;
  level: string;
  state: string;
  members: string[];
  degraded: boolean;
};

export type LvmVolumeGroup = {
  name: string;
  size: string;
  free: string;
};

export type LvmLogicalVolume = {
  name: string;
  volumeGroup: string;
  size: string;
};

export type LvmPhysicalVolume = {
  name: string;
  volumeGroup: string;
  size: string;
};

export type BtrfsDevice = {
  pool: string;
  device: string;
};

export type BlockDevice = {
  name: string;
  size: string;
  type: string;
  fstype: string;
  mountpoint: string;
  model: string;
};

export type StoragePools = {
  mdstat: MdArray[];
  mdstatRaw: string;
  lvm: {
    present: boolean;
    volumeGroups: LvmVolumeGroup[];
    logicalVolumes: LvmLogicalVolume[];
    physicalVolumes: LvmPhysicalVolume[];
  };
  btrfs: { present: boolean; devices: BtrfsDevice[] };
  blockDevices: BlockDevice[];
  filesystems: Array<{ device: string; uuid: string | null; type: string | null; label: string | null }>;
};

export type SystemInfo = {
  host: string;
  commandTimeoutMs: number;
  defaultShare: string;
  osRelease: Record<string, string>;
  cpuCoreCount: number | null;
  loadAverage: string | null;
  memoryTotalKb: number | null;
  memoryAvailableKb: number | null;
  uptime: string;
  temperatureCelsius: Record<string, number>;
  disks: DiskEntry[];
  dockerVersion: string | null;
};

export class SystemService {
  constructor(private readonly ctx: ServiceContext) {}

  async status(): Promise<SystemStatus> {
    const command = [
      sectionCommand("HOSTNAME", "hostname"),
      sectionCommand("UNAME", "uname -srm"),
      sectionCommand("UPTIME", "uptime -p 2>/dev/null || uptime"),
      sectionCommand("DOCKER", "docker --version 2>/dev/null || echo NOT_INSTALLED")
    ].join("\n");

    const { stdout } = await execChecked(this.ctx.executor, command);
    const sections = parseSections(stdout);
    const dockerRaw = (sections.DOCKER ?? "").trim();

    return {
      reachable: true,
      host: `${this.ctx.config.host}:${this.ctx.config.port}`,
      hostname: sections.HOSTNAME ?? "",
      platform: sections.UNAME ?? "",
      kernel: sections.UNAME ?? "",
      uptime: sections.UPTIME ?? "",
      dockerInstalled: dockerRaw.length > 0 && dockerRaw !== "NOT_INSTALLED",
      dockerVersion: dockerRaw !== "NOT_INSTALLED" && dockerRaw ? dockerRaw : null
    };
  }

  async info(): Promise<SystemInfo> {
    const command = [
      sectionCommand("OS_RELEASE", "cat /etc/os-release 2>/dev/null || cat /etc/ugos-release 2>/dev/null || true"),
      sectionCommand("CPU", "nproc 2>/dev/null || true"),
      sectionCommand("LOAD", "cat /proc/loadavg 2>/dev/null || true"),
      sectionCommand("MEM", "cat /proc/meminfo 2>/dev/null || true"),
      sectionCommand("UPTIME", "uptime -p 2>/dev/null || uptime"),
      sectionCommand("TEMP", "for z in /sys/class/thermal/thermal_zone*/temp; do [ -r \"$z\" ] && printf '%s=%s\\n' \"$z\" \"$(cat \"$z\")\"; done 2>/dev/null || true"),
      sectionCommand("DISK", "df -h 2>/dev/null || true"),
      sectionCommand("DOCKER", "docker --version 2>/dev/null || echo NOT_INSTALLED")
    ].join("\n");

    const { stdout } = await execChecked(this.ctx.executor, command);
    const sections = parseSections(stdout);

    const osRelease = parseKeyValueBlock(sections.OS_RELEASE ?? "");
    const memKb = parseKeyValueBlock(sections.MEM ?? "");
    const cpuCoreRaw = (sections.CPU ?? "").trim();
    const loadRaw = (sections.LOAD ?? "").trim();
    const tempRaw = sections.TEMP ?? "";
    const dockerRaw = (sections.DOCKER ?? "").trim();

    return {
      host: `${this.ctx.config.host}:${this.ctx.config.port}`,
      commandTimeoutMs: this.ctx.config.commandTimeoutMs,
      defaultShare: this.ctx.config.defaultShare,
      osRelease,
      cpuCoreCount: cpuCoreRaw && Number.isFinite(Number(cpuCoreRaw)) ? Number(cpuCoreRaw) : null,
      loadAverage: loadRaw ? loadRaw.split(/\s+/).slice(0, 3).join(" ") : null,
      memoryTotalKb: toInt(memKb.MemTotal),
      memoryAvailableKb: toInt(memKb.MemAvailable),
      uptime: sections.UPTIME ?? "",
      temperatureCelsius: parseTemperatures(tempRaw),
      disks: parseDf(sections.DISK ?? ""),
      dockerVersion: dockerRaw !== "NOT_INSTALLED" && dockerRaw ? dockerRaw : null
    };
  }

  async dockerVersion(): Promise<{ installed: boolean; version: string | null }> {
    const { stdout } = await execChecked(this.ctx.executor, "docker --version 2>/dev/null || echo NOT_INSTALLED");
    const raw = stdout.trim();
    return { installed: raw !== "NOT_INSTALLED" && raw.length > 0, version: raw || null };
  }

  /** Storage pool / RAID / filesystem health across whatever layers the box uses. */
  async pools(): Promise<StoragePools> {
    const command = [
      sectionCommand("MDSTAT", "cat /proc/mdstat 2>/dev/null || true"),
      sectionCommand("LVM", "which lvm >/dev/null 2>&1 && lvm fullreport 2>/dev/null | head -n 200 || true"),
      sectionCommand("BTRFS", "which btrfs >/dev/null 2>&1 && btrfs filesystem show 2>/dev/null || true"),
      sectionCommand("LSBLK", "lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL 2>/dev/null || true"),
      sectionCommand("BLKID", "blkid 2>/dev/null || true")
    ].join("\n");

    const { stdout } = await execChecked(this.ctx.executor, command);
    const sections = parseSections(stdout);

    return {
      mdstat: parseMdstat(sections.MDSTAT ?? ""),
      mdstatRaw: (sections.MDSTAT ?? "").trim(),
      lvm: parseLvm(sections.LVM ?? ""),
      btrfs: parseBtrfs(sections.BTRFS ?? ""),
      blockDevices: parseLsblk(sections.LSBLK ?? ""),
      filesystems: parseBlkid(sections.BLKID ?? "")
    };
  }
}

/**
 * Parse `KEY=VALUE` blocks (os-release) and `Key: value` blocks (/proc/meminfo)
 * alike, taking the first `=` or `:` as the separator.
 */
function parseKeyValueBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    const colon = trimmed.indexOf(":");
    const index = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim().replace(/^#\s*/, "");
    let value = trimmed.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function toInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value.replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTemperatures(block: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of block.split(/\r?\n/)) {
    const [zone, raw] = line.split("=");
    if (!zone || !raw) {
      continue;
    }
    const value = Number(raw.trim());
    if (Number.isFinite(value)) {
      out[zone] = value > 1000 ? value / 1000 : value;
    }
  }
  return out;
}

function parseDf(block: string): DiskEntry[] {
  const entries: DiskEntry[] = [];
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^Filesystem/i.test(trimmed)) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) {
      continue;
    }
    const [filesystem = "", size = "", used = "", available = "", usePercent = ""] = parts;
    const mountedOn = parts.slice(5).join(" ");
    entries.push({ filesystem, size, used, available, usePercent, mountedOn });
  }
  return entries;
}

/**
 * Parse /proc/mdstat into arrays. A device line looks like:
 *   md0 : active raid1 sda1[0] sdb1[1]
 * or a degraded array:  md0 : active raid1 sda1[0] sdb1[1](F)
 */
export function parseMdstat(block: string): MdArray[] {
  const arrays: MdArray[] = [];
  for (const line of block.split(/\r?\n/)) {
    const match = /^(md\d+)\s*:\s*(\S+)\s+(\S+)\s+(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, name = "", state = "", level = "", rest = ""] = match;
    const members = rest
      .split(/\s+/)
      .filter((token) => /\[\d+\]/.test(token))
      .map((token) => token.replace(/\[[^\]]*\](\([A-Z]\))?/g, "").trim())
      .filter(Boolean);
    const degraded = /\(F\)|_/.test(rest) || /degraded/i.test(line);
    arrays.push({ name, level, state, members, degraded });
  }
  return arrays;
}

export function parseLvm(block: string): StoragePools["lvm"] {
  const volumeGroups: LvmVolumeGroup[] = [];
  const logicalVolumes: LvmLogicalVolume[] = [];
  const physicalVolumes: LvmPhysicalVolume[] = [];

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const columns = line.split(/\s+/);
    if (columns.length < 2) {
      continue;
    }

    const first = columns[0] ?? "";
    const second = columns[1] ?? "";

    // `lvm fullreport` groups by type; identify rows heuristically by column shape.
    if (second === "vg" || /^vg\d+/.test(first)) {
      const [, , name = "", , size = "", free = ""] = columns;
      if (name) {
        volumeGroups.push({ name, size, free });
      }
    } else if (second === "lv" || /^lv\d+/.test(first)) {
      const [, , name = "", vg = "", size = ""] = columns;
      if (name) {
        logicalVolumes.push({ name, volumeGroup: vg, size });
      }
    } else if (columns.length === 2 && /^\/dev\//.test(first)) {
      physicalVolumes.push({ name: first, volumeGroup: second, size: "" });
    }
  }

  return {
    present: block.trim().length > 0,
    volumeGroups,
    logicalVolumes,
    physicalVolumes
  };
}

export function parseBtrfs(block: string): StoragePools["btrfs"] {
  const devices: BtrfsDevice[] = [];
  let currentPool = "";
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const labelMatch = /^Label:\s*(\S+)?\s+uuid:/.exec(line);
    if (labelMatch) {
      currentPool = labelMatch[1] && labelMatch[1] !== "none" ? labelMatch[1] : "btrfs";
      continue;
    }
    const deviceMatch = /^\/dev\/\S+/.exec(line);
    if (deviceMatch) {
      devices.push({ pool: currentPool, device: line.split(/\s+/)[0] ?? "" });
    }
  }
  return { present: block.trim().length > 0, devices };
}

export function parseLsblk(block: string): BlockDevice[] {
  const out: BlockDevice[] = [];
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^NAME\b/.test(trimmed)) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) {
      continue;
    }
    const type = parts[2] ?? "";
    const [name = "", size = ""] = parts;
    // Columns after TYPE are optional; fstype/mountpoint/model may be empty.
    const fstype = parts[3] ?? "";
    const mountpoint = parts[4] ?? "";
    const model = parts.slice(5).join(" ");
    out.push({ name, size, type, fstype, mountpoint, model });
  }
  return out;
}

export function parseBlkid(block: string): StoragePools["filesystems"] {
  const out: StoragePools["filesystems"] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("/dev/")) {
      continue;
    }
    const [deviceToken = "", ...attributes] = line.split(/\s+/);
    const device = deviceToken.replace(/:$/, "");
    const map: Record<string, string> = {};
    for (const attribute of attributes) {
      const match = /([A-Z_]+)="([^"]*)"/.exec(attribute);
      if (match && match[1]) {
        map[match[1]] = match[2] ?? "";
      }
    }
    out.push({
      device,
      uuid: map.UUID ?? null,
      type: map.TYPE ?? null,
      label: map.LABEL ?? null
    });
  }
  return out;
}
