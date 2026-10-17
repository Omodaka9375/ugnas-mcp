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

  /** Storage pool / RAID / filesystem health across whatever layers the box uses. */
  async pools(): Promise<StoragePools> {
    const command = [
      sectionCommand("MDSTAT", "cat /proc/mdstat 2>/dev/null || true"),
      sectionCommand(
        "LVM",
        // `lvm fullreport` is awkward to parse; the per-object listings with a
        // defined separator parse cleanly and exist wherever LVM does.
        "command -v vgs >/dev/null 2>&1 && " +
          "(vgs --noheadings --nosuffix --units b --separator '|' ; echo '---' ; " +
          "lvs --noheadings --nosuffix --units b --separator '|' ; echo '---' ; " +
          "pvs --noheadings --nosuffix --units b --separator '|') 2>/dev/null || true"
      ),
      sectionCommand("BTRFS", "command -v btrfs >/dev/null 2>&1 && btrfs filesystem show 2>/dev/null || true"),
      // -P gives KEY="value" pairs that survive blank columns.
      sectionCommand(
        "LSBLK",
        "command -v lsblk >/dev/null 2>&1 && lsblk -P -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL 2>/dev/null || true"
      ),
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

/**
 * Parse the three-section `vgs/lvs/pvs --separator '|'` output produced by
 * SystemService.pools: volume groups, then `---`, then logical volumes, then
 * `---`, then physical volumes. Fields with vgs: vg_name|vg_size|vg_free;
 * lvs: lv_name|vg_name|lv_size; pvs: pv_name|vg_name|pv_size.
 */
export function parseLvm(block: string): StoragePools["lvm"] {
  const volumeGroups: LvmVolumeGroup[] = [];
  const logicalVolumes: LvmLogicalVolume[] = [];
  const physicalVolumes: LvmPhysicalVolume[] = [];

  let section = 0;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line === "---") {
      section += 1;
      continue;
    }

    const fields = line.split("|").map((field) => field.trim());
    if (section === 0 && fields.length >= 3) {
      // vgs --noheadings --units b: vg_name|vg_size|vg_free
      const [name = "", size = "", free = ""] = fields;
      if (name) volumeGroups.push({ name, size, free });
    } else if (section === 1 && fields.length >= 3) {
      // lvs: lv_name|vg_name|lv_size
      const [name = "", vg = "", size = ""] = fields;
      if (name) logicalVolumes.push({ name, volumeGroup: vg, size });
    } else if (section === 2 && fields.length >= 2) {
      // pvs: pv_name|vg_name|pv_size
      const [name = "", vg = "", size = ""] = fields;
      if (name) physicalVolumes.push({ name, volumeGroup: vg, size });
    }
  }

  return {
    present: volumeGroups.length > 0 || logicalVolumes.length > 0 || physicalVolumes.length > 0,
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
      // Labels are quoted when they contain spaces or lookups ('main');
      // strip the quotes for the pool name.
      const rawLabel = labelMatch[1] ?? "";
      const label = rawLabel.replace(/^(?:'|"|`)|(?:'|"|`)$/g, "");
      currentPool = label && label !== "none" ? label : "btrfs";
      continue;
    }
    // `btrfs filesystem show` device lines look like:
    //   \tdevid    1 size 2.00GiB used 512.00MiB path /dev/sda
    const pathMatch = /\bpath\s+(\/dev\/\S+)/.exec(line);
    if (pathMatch && pathMatch[1]) {
      devices.push({ pool: currentPool, device: pathMatch[1] });
    }
  }
  return { present: devices.length > 0, devices };
}

/**
 * Parse `lsblk -P -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL` output:
 * `NAME="sda" SIZE="2T" TYPE="disk" ...`. KEY="value" pairs survive blank
 * columns (unlike plain-column output, where they misalign).
 */
export function parseLsblk(block: string): BlockDevice[] {
  const out: BlockDevice[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("NAME=")) {
      continue;
    }
    const map: Record<string, string> = {};
    const pair = /([A-Z_]+)="((?:[^"\\]|\\.)*)"/g;
    let match: RegExpExecArray | null;
    while ((match = pair.exec(line)) !== null) {
      if (match[1]) {
        map[match[1]] = (match[2] ?? "").replace(/\\(.)/g, "$1");
      }
    }
    if (!map.NAME) {
      continue;
    }
    out.push({
      name: map.NAME,
      size: map.SIZE ?? "",
      type: map.TYPE ?? "",
      fstype: map.FSTYPE ?? "",
      mountpoint: map.MOUNTPOINT ?? "",
      model: map.MODEL ?? ""
    });
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
