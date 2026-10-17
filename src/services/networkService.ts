import { shq } from "../ssh/shellQuote.js";
import type { ServiceContext } from "./context.js";
import { execChecked, parseJsonLines, parseSections, sectionCommand } from "./util.js";

export type HostInterface = {
  name: string;
  family: "inet" | "inet6";
  address: string;
  cidr: string;
  scope: string;
};

export class NetworkService {
  constructor(private readonly ctx: ServiceContext) {}

  async interfaces(): Promise<HostInterface[]> {
    const { stdout } = await execChecked(
      this.ctx.executor,
      "ip -o addr show 2>/dev/null || ifconfig -a 2>/dev/null || true"
    );

    const out: HostInterface[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) {
        continue;
      }
      const [, name = "", family = "", cidr = ""] = parts;
      if (family !== "inet" && family !== "inet6") {
        continue;
      }
      const [address = ""] = cidr.split("/");
      const scopeIndex = parts.indexOf("scope");
      const scope = scopeIndex >= 0 ? (parts[scopeIndex + 1] ?? "global") : "global";
      out.push({ name: name.replace(/@.*$/, ""), family, address, cidr, scope });
    }
    return out;
  }

  async routes(): Promise<{ ipv4: string[]; ipv6: string[] }> {
    const command = [
      sectionCommand("V4", "ip -4 route show 2>/dev/null || true"),
      sectionCommand("V6", "ip -6 route show 2>/dev/null || true")
    ].join("\n");
    const { stdout } = await execChecked(this.ctx.executor, command);
    const sections = parseSections(stdout);
    return {
      ipv4: (sections.V4 ?? "").split(/\r?\n/).filter(Boolean),
      ipv6: (sections.V6 ?? "").split(/\r?\n/).filter(Boolean)
    };
  }

  async listeningPorts(): Promise<string[]> {
    const { stdout } = await execChecked(
      this.ctx.executor,
      "ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null || true"
    );
    return stdout.split(/\r?\n/).filter(Boolean);
  }

  async dockerNetworks(): Promise<Array<Record<string, string>>> {
    const { stdout } = await execChecked(
      this.ctx.executor,
      "docker network ls --format '{{json .}}' 2>/dev/null || true"
    );
    return parseJsonLines(stdout);
  }

  async dockerNetworkInspect(name: string): Promise<Record<string, unknown>> {
    const { stdout } = await execChecked(
      this.ctx.executor,
      `docker network inspect ${shq(name)} 2>/dev/null || true`
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed) && parsed.length === 1) {
        return parsed[0] as Record<string, unknown>;
      }
      return Array.isArray(parsed) ? { items: parsed } : (parsed as Record<string, unknown>);
    } catch {
      return { raw: stdout };
    }
  }
}
