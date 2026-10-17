import { shq } from "../ssh/shellQuote.js";
import type { ServiceContext } from "./context.js";
import {
  execChecked,
  makePlan,
  parseJsonLines,
  planOrExecute,
  resolveRemotePath,
  type ToolOutcome
} from "./util.js";

export type ContainerSummary = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
};

export class DockerService {
  constructor(private readonly ctx: ServiceContext) {}

  async listContainers(input: { all?: boolean } = {}): Promise<ContainerSummary[]> {
    const flag = input.all === false ? "" : "-a";
    const { stdout } = await execChecked(
      this.ctx.executor,
      `docker ps ${flag} --format '{{json .}}' 2>/dev/null || true`
    );
    return parseJsonLines<Record<string, string>>(stdout).map((row) => ({
      id: row.ID ?? row.Id ?? "",
      name: row.Names ?? row.Name ?? "",
      image: row.Image ?? "",
      state: row.State ?? "",
      status: row.Status ?? "",
      ports: row.Ports ?? ""
    }));
  }

  async inspectContainer(nameOrId: string): Promise<Record<string, unknown>> {
    const { stdout } = await execChecked(
      this.ctx.executor,
      `docker inspect ${shq(nameOrId)} 2>/dev/null || true`
    );
    const parsed = safeJson(stdout);
    if (Array.isArray(parsed) && parsed.length === 1) {
      return parsed[0] as Record<string, unknown>;
    }
    return Array.isArray(parsed) ? { items: parsed } : parsed;
  }

  async containerLogs(nameOrId: string, tail: number): Promise<{ nameOrId: string; tail: number; content: string }> {
    const { stdout } = await execChecked(
      this.ctx.executor,
      `docker logs --tail ${Math.max(1, Math.floor(tail))} ${shq(nameOrId)} 2>&1 || true`
    );
    return { nameOrId, tail, content: stdout };
  }

  async listImages(): Promise<Array<Record<string, string>>> {
    const { stdout } = await execChecked(
      this.ctx.executor,
      `docker images --format '{{json .}}' 2>/dev/null || true`
    );
    return parseJsonLines(stdout);
  }

  async listNetworks(): Promise<Array<Record<string, string>>> {
    const { stdout } = await execChecked(
      this.ctx.executor,
      `docker network ls --format '{{json .}}' 2>/dev/null || true`
    );
    return parseJsonLines(stdout);
  }

  async inspectNetwork(name: string): Promise<Record<string, unknown>> {
    const { stdout } = await execChecked(
      this.ctx.executor,
      `docker network inspect ${shq(name)} 2>/dev/null || true`
    );
    const parsed = safeJson(stdout);
    if (Array.isArray(parsed) && parsed.length === 1) {
      return parsed[0] as Record<string, unknown>;
    }
    return Array.isArray(parsed) ? { items: parsed } : parsed;
  }

  startContainer(nameOrId: string, confirmationToken?: string): Promise<ToolOutcome> {
    return this.containerAction("start", nameOrId, confirmationToken);
  }

  stopContainer(nameOrId: string, confirmationToken?: string): Promise<ToolOutcome> {
    return this.containerAction("stop", nameOrId, confirmationToken);
  }

  restartContainer(nameOrId: string, confirmationToken?: string): Promise<ToolOutcome> {
    return this.containerAction("restart", nameOrId, confirmationToken);
  }

  removeContainer(input: { nameOrId: string; force?: boolean; volumes?: boolean; token?: string }): Promise<ToolOutcome> {
    const flags = [input.force ? "-f" : "", input.volumes ? "-v" : ""].filter(Boolean).join(" ");
    const command = `docker rm ${flags ? `${flags} ` : ""}${shq(input.nameOrId)}`;
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "docker.containers.remove",
        summary: `Remove container "${input.nameOrId}"${input.volumes ? " including its anonymous volumes" : ""}.`,
        commands: [command],
        payload: { nameOrId: input.nameOrId, force: Boolean(input.force), volumes: Boolean(input.volumes) },
        warnings: ["Removing a container is destructive and cannot be undone."]
      }),
      input.token
    );
  }

  pullImage(input: { image: string; token?: string }): Promise<ToolOutcome> {
    const command = `docker pull ${shq(input.image)}`;
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "docker.images.pull",
        summary: `Pull image "${input.image}" from its registry.`,
        commands: [command],
        payload: { image: input.image }
      }),
      input.token
    );
  }

  removeImage(input: { image: string; force?: boolean; token?: string }): Promise<ToolOutcome> {
    const command = `docker rmi ${input.force ? "-f " : ""}${shq(input.image)}`;
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "docker.images.remove",
        summary: `Remove local image "${input.image}".`,
        commands: [command],
        payload: { image: input.image, force: Boolean(input.force) },
        warnings: ["Removing an image in use by containers will fail unless forced."]
      }),
      input.token
    );
  }

  createNetwork(input: { name: string; driver?: string; subnet?: string; token?: string }): Promise<ToolOutcome> {
    const parts = ["docker", "network", "create"];
    if (input.driver) parts.push("--driver", shq(input.driver));
    if (input.subnet) parts.push("--subnet", shq(input.subnet));
    parts.push(shq(input.name));
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "docker.networks.create",
        summary: `Create Docker network "${input.name}"${input.driver ? ` (driver ${input.driver})` : ""}${input.subnet ? ` on ${input.subnet}` : ""}.`,
        commands: [parts.join(" ")],
        payload: { name: input.name, driver: input.driver ?? null, subnet: input.subnet ?? null }
      }),
      input.token
    );
  }

  removeNetwork(input: { name: string; token?: string }): Promise<ToolOutcome> {
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "docker.networks.remove",
        summary: `Remove Docker network "${input.name}".`,
        commands: [`docker network rm ${shq(input.name)}`],
        payload: { name: input.name },
        warnings: ["Fails if any container is still attached."]
      }),
      input.token
    );
  }

  connectNetwork(input: { network: string; container: string; token?: string }): Promise<ToolOutcome> {
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "docker.networks.connect",
        summary: `Connect container "${input.container}" to network "${input.network}".`,
        commands: [`docker network connect ${shq(input.network)} ${shq(input.container)}`],
        payload: { network: input.network, container: input.container }
      }),
      input.token
    );
  }

  disconnectNetwork(input: { network: string; container: string; force?: boolean; token?: string }): Promise<ToolOutcome> {
    return planOrExecute(
      this.ctx,
      makePlan({
        action: "docker.networks.disconnect",
        summary: `Disconnect container "${input.container}" from network "${input.network}".`,
        commands: [`docker network disconnect ${input.force ? "-f " : ""}${shq(input.network)} ${shq(input.container)}`],
        payload: { network: input.network, container: input.container, force: Boolean(input.force) }
      }),
      input.token
    );
  }

  compose(input: { directory: string; action: "up" | "down" | "restart"; file?: string; token?: string }): Promise<ToolOutcome> {
    const dir = resolveRemotePath(this.ctx.config, input.directory);
    const fileFlag = input.file ? `-f ${shq(input.file)} ` : "";
    const verb = input.action === "down" ? "down" : input.action === "restart" ? "restart" : "up -d";
    const command = `cd ${shq(dir)} && docker compose ${fileFlag}${verb}`;
    return planOrExecute(
      this.ctx,
      makePlan({
        action: `docker.compose.${input.action}`,
        summary: `Run "docker compose ${verb}" in ${dir}.`,
        commands: [command],
        payload: { directory: dir, action: input.action, file: input.file ?? null },
        warnings: input.action === "down" ? ["This stops and removes the stack's containers."] : []
      }),
      input.token
    );
  }

  private async containerAction(
    verb: "start" | "stop" | "restart",
    nameOrId: string,
    confirmationToken?: string
  ): Promise<ToolOutcome> {
    return planOrExecute(
      this.ctx,
      makePlan({
        action: `docker.containers.${verb}`,
        summary: `${verb[0]?.toUpperCase()}${verb.slice(1)} container "${nameOrId}".`,
        commands: [`docker ${verb} ${shq(nameOrId)}`],
        payload: { nameOrId, verb }
      }),
      confirmationToken
    );
  }
}

function safeJson(text: string): Record<string, unknown> | unknown[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown> | unknown[];
  } catch {
    return { raw: text };
  }
}
