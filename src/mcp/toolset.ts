import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ServiceContext } from "../services/context.js";
import { SystemService } from "../services/systemService.js";
import { DockerService } from "../services/dockerService.js";
import { FileService } from "../services/fileService.js";
import { BackupService } from "../services/backupService.js";
import { NetworkService } from "../services/networkService.js";

function respond(value: Record<string, unknown> | unknown[]) {
  const structuredContent: Record<string, unknown> = Array.isArray(value) ? { items: value } : value;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent
  };
}

const tokenField = z
  .string()
  .optional()
  .describe(
    "Confirmation token echoed from a prior dry-run of THIS tool. Omit it to receive a dry-run plan."
  );

export function registerTools(server: McpServer, ctx: ServiceContext): void {
  const system = new SystemService(ctx);
  const docker = new DockerService(ctx);
  const files = new FileService(ctx);
  const backup = new BackupService(ctx);
  const network = new NetworkService(ctx);

  // ---------------------------------------------------------------------------
  // Connection & system
  // ---------------------------------------------------------------------------
  server.registerTool(
    "system.status",
    {
      description:
        "Test connectivity to the configured UGREEN NAS over SSH and report hostname, kernel, uptime, and whether Docker is available. Read-only.",
      inputSchema: {}
    },
    async () => respond((await system.status()) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "system.info",
    {
      description:
        "Report system details: OS release, CPU cores, load average, memory, temperatures, mounted disks, and Docker version. Read-only.",
      inputSchema: {}
    },
    async () => respond((await system.info()) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "system.pools",
    {
      description:
        "Report storage pool and RAID health: mdadm arrays and degradation state, LVM volume/logical/physical volumes, btrfs devices, block devices and filesystems. Read-only.",
      inputSchema: {}
    },
    async () => respond((await system.pools()) as unknown as Record<string, unknown>)
  );

  // ---------------------------------------------------------------------------
  // Docker
  // ---------------------------------------------------------------------------
  server.registerTool(
    "docker.containers.list",
    {
      description: "List Docker containers on the NAS with id, name, image, state and status. Read-only.",
      inputSchema: {
        all: z.boolean().optional().describe("Include stopped containers (default true).")
      }
    },
    async ({ all }) => respond({ containers: await docker.listContainers({ all }) })
  );

  server.registerTool(
    "docker.containers.inspect",
    {
      description: "Return full `docker inspect` JSON for one container. Read-only.",
      inputSchema: {
        container: z.string().describe("Container name or id.")
      }
    },
    async ({ container }) => respond(await docker.inspectContainer(container))
  );

  server.registerTool(
    "docker.containers.logs",
    {
      description: "Fetch the most recent log lines from a container. Read-only.",
      inputSchema: {
        container: z.string().describe("Container name or id."),
        tail: z.number().int().positive().max(5000).optional().describe("Number of lines (default 200).")
      }
    },
    async ({ container, tail }) => respond(await docker.containerLogs(container, tail ?? 200))
  );

  server.registerTool(
    "docker.containers.start",
    {
      description: "Start a stopped container. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: { container: z.string(), confirmToken: tokenField }
    },
    async ({ container, confirmToken }) =>
      respond((await docker.startContainer(container, confirmToken)) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "docker.containers.stop",
    {
      description: "Stop a running container. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: { container: z.string(), confirmToken: tokenField }
    },
    async ({ container, confirmToken }) =>
      respond((await docker.stopContainer(container, confirmToken)) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "docker.containers.restart",
    {
      description: "Restart a container. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: { container: z.string(), confirmToken: tokenField }
    },
    async ({ container, confirmToken }) =>
      respond((await docker.restartContainer(container, confirmToken)) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "docker.containers.remove",
    {
      description: "Delete a container. Destructive: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        container: z.string(),
        force: z.boolean().optional().describe("Force removal of a running container."),
        volumes: z.boolean().optional().describe("Also remove anonymous volumes."),
        confirmToken: tokenField
      }
    },
    async ({ container, force, volumes, confirmToken }) =>
      respond(
        (await docker.removeContainer({
          nameOrId: container,
          force,
          volumes,
          token: confirmToken
        })) as unknown as Record<string, unknown>
      )
  );

  server.registerTool(
    "docker.images.list",
    {
      description: "List locally stored Docker images. Read-only.",
      inputSchema: {}
    },
    async () => respond({ images: await docker.listImages() })
  );

  server.registerTool(
    "docker.images.pull",
    {
      description: "Pull an image from its registry. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: { image: z.string().describe("Image reference, e.g. nginx:latest."), confirmToken: tokenField }
    },
    async ({ image, confirmToken }) =>
      respond((await docker.pullImage({ image, token: confirmToken })) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "docker.images.remove",
    {
      description: "Remove a local image. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        image: z.string(),
        force: z.boolean().optional(),
        confirmToken: tokenField
      }
    },
    async ({ image, force, confirmToken }) =>
      respond(
        (await docker.removeImage({ image, force, token: confirmToken })) as unknown as Record<string, unknown>
      )
  );

  server.registerTool(
    "docker.networks.list",
    {
      description: "List Docker networks. Read-only.",
      inputSchema: {}
    },
    async () => respond({ networks: await docker.listNetworks() })
  );

  server.registerTool(
    "docker.networks.inspect",
    {
      description: "Return `docker network inspect` JSON (subnets, attached containers). Read-only.",
      inputSchema: { network: z.string() }
    },
    async ({ network: name }) => respond(await docker.inspectNetwork(name))
  );

  server.registerTool(
    "docker.networks.create",
    {
      description: "Create a Docker network. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        name: z.string(),
        driver: z.string().optional().describe("e.g. bridge, macvlan, overlay."),
        subnet: z.string().optional().describe("CIDR, e.g. 10.0.0.0/24."),
        confirmToken: tokenField
      }
    },
    async ({ name, driver, subnet, confirmToken }) =>
      respond(
        (await docker.createNetwork({ name, driver, subnet, token: confirmToken })) as unknown as Record<
          string,
          unknown
        >
      )
  );

  server.registerTool(
    "docker.networks.remove",
    {
      description: "Remove a Docker network. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: { network: z.string(), confirmToken: tokenField }
    },
    async ({ network: name, confirmToken }) =>
      respond((await docker.removeNetwork({ name, token: confirmToken })) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "docker.networks.connect",
    {
      description: "Attach a container to a network. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: { network: z.string(), container: z.string(), confirmToken: tokenField }
    },
    async ({ network: net, container, confirmToken }) =>
      respond(
        (await docker.connectNetwork({ network: net, container, token: confirmToken })) as unknown as Record<
          string,
          unknown
        >
      )
  );

  server.registerTool(
    "docker.networks.disconnect",
    {
      description: "Detach a container from a network. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        network: z.string(),
        container: z.string(),
        force: z.boolean().optional(),
        confirmToken: tokenField
      }
    },
    async ({ network: net, container, force, confirmToken }) =>
      respond(
        (await docker.disconnectNetwork({
          network: net,
          container,
          force,
          token: confirmToken
        })) as unknown as Record<string, unknown>
      )
  );

  server.registerTool(
    "docker.compose",
    {
      description:
        "Run `docker compose up -d` / `down` / `restart` for a stack directory on the NAS. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        directory: z.string().describe("Directory containing the compose file (relative paths resolve against defaultShare)."),
        action: z.enum(["up", "down", "restart"]),
        file: z.string().optional().describe("Optional compose file name."),
        confirmToken: tokenField
      }
    },
    async ({ directory, action, file, confirmToken }) =>
      respond(
        (await docker.compose({ directory, action, file, token: confirmToken })) as unknown as Record<
          string,
          unknown
        >
      )
  );

  // ---------------------------------------------------------------------------
  // Files & data
  // ---------------------------------------------------------------------------
  server.registerTool(
    "files.list",
    {
      description: "List a directory on the NAS (name, type, size, owner, modified). Read-only.",
      inputSchema: { directory: z.string().describe("Absolute path, or relative to defaultShare.") }
    },
    async ({ directory }) => respond(await files.list(directory))
  );

  server.registerTool(
    "files.usage",
    {
      description: "Report disk usage (`du`) for a path, optionally per subdirectory. Read-only.",
      inputSchema: {
        path: z.string(),
        depth: z.number().int().min(0).max(4).optional().describe("Per-directory depth (omit for total size only).")
      }
    },
    async ({ path, depth }) => respond(await files.usage({ path, depth }))
  );

  server.registerTool(
    "files.find",
    {
      description:
        "Search for files by name glob and/or extension across a directory tree. Read-only. Returns path, size, modified time, and extension for each match.",
      inputSchema: {
        path: z.string().describe("Directory to search (absolute, or relative to defaultShare)."),
        name: z.string().optional().describe("Filename glob, e.g. '*.mp4' or 'IMG_2024*'."),
        extensions: z
          .array(z.string())
          .optional()
          .describe("Only these extensions, e.g. ['mp4','mkv'] (case-insensitive; leading dot optional)."),
        type: z.enum(["file", "dir"]).optional().describe("Match files (default) or directories."),
        maxDepth: z.number().int().positive().optional().describe("Limit recursion depth."),
        limit: z.number().int().positive().max(1000).optional().describe("Max results (default 100).")
      }
    },
    async ({ path, name, extensions, type, maxDepth, limit }) =>
      respond(await files.find({ path, name, extensions, type, maxDepth, limit }))
  );

  server.registerTool(
    "files.thumbnail",
    {
      description:
        "Generate a preview thumbnail of an image or video on the NAS with ffmpeg and download it locally. For videos a frame is captured (default 1s in). Mutating (it writes a file on the local machine): returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        path: z.string().describe("Image or video file on the NAS."),
        localPath: z.string().describe("Where to save the thumbnail on the machine running this MCP server."),
        width: z.number().int().min(16).max(4096).optional().describe("Thumbnail width in px (default 640; height auto)."),
        time: z.string().optional().describe("Video frame timestamp, e.g. '00:00:05' (default 00:00:01)."),
        confirmToken: tokenField
      }
    },
    async ({ path, localPath, width, time, confirmToken }) =>
      respond(
        (await files.thumbnail({ path, localPath, width, time, token: confirmToken })) as unknown as Record<
          string,
          unknown
        >
      )
  );

  server.registerTool(
    "files.mkdir",
    {
      description: "Create a directory. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: { path: z.string(), confirmToken: tokenField }
    },
    async ({ path, confirmToken }) =>
      respond((await files.makeDirectory({ path, token: confirmToken })) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "files.copy",
    {
      description:
        "Copy a file or directory within the NAS (or NAS-to-NAS). Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: { source: z.string(), destination: z.string(), confirmToken: tokenField }
    },
    async ({ source, destination, confirmToken }) =>
      respond(
        (await files.copy({ source, destination, token: confirmToken })) as unknown as Record<string, unknown>
      )
  );

  server.registerTool(
    "files.move",
    {
      description: "Move or rename a path on the NAS. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: { source: z.string(), destination: z.string(), confirmToken: tokenField }
    },
    async ({ source, destination, confirmToken }) =>
      respond(
        (await files.move({ source, destination, token: confirmToken })) as unknown as Record<string, unknown>
      )
  );

  server.registerTool(
    "files.remove",
    {
      description: "Delete a file or directory. Destructive: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        path: z.string(),
        recursive: z.boolean().optional().describe("Delete directories recursively (default true)."),
        confirmToken: tokenField
      }
    },
    async ({ path, recursive, confirmToken }) =>
      respond((await files.remove({ path, recursive, token: confirmToken })) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "files.upload",
    {
      description:
        "Upload a local file to the NAS via SFTP. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        localPath: z.string().describe("Path on the machine running this MCP server."),
        remotePath: z.string().describe("Destination on the NAS."),
        confirmToken: tokenField
      }
    },
    async ({ localPath, remotePath, confirmToken }) =>
      respond(
        (await files.upload({ localPath, remotePath, token: confirmToken })) as unknown as Record<string, unknown>
      )
  );

  server.registerTool(
    "files.download",
    {
      description:
        "Download a file from the NAS to the local machine via SFTP. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        remotePath: z.string().describe("File on the NAS."),
        localPath: z.string().describe("Destination on the machine running this MCP server."),
        confirmToken: tokenField
      }
    },
    async ({ remotePath, localPath, confirmToken }) =>
      respond(
        (await files.download({ remotePath, localPath, token: confirmToken })) as unknown as Record<string, unknown>
      )
  );

  server.registerTool(
    "files.sync",
    {
      description:
        "Sync a path to another on the NAS (or NAS-to-NAS) with rsync. A trailing slash on the source means 'contents', otherwise 'the directory'. If rsync is missing on the NAS, pass fallback:'cp' to use a built-in copy fallback (no delete/mirror). Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        source: z.string().describe("Source path (trailing slash copies contents only)."),
        destination: z.string().describe("Destination path (trailing slash = contents)."),
        delete: z.boolean().optional().describe("Mirror the source, deleting extra files at the destination."),
        dryRun: z.boolean().optional().describe("Add rsync --dry-run to preview changes without writing."),
        extraArgs: z.array(z.string()).optional().describe("Additional rsync flags, e.g. ['--exclude','*.tmp']."),
        fallback: z
          .enum(["refuse", "cp"])
          .optional()
          .describe(
            "What to do when rsync is missing on the NAS: 'refuse' (default) or 'cp' to use the built-in cp -a copy fallback."
          ),
        confirmToken: tokenField
      }
    },
    async ({ source, destination, delete: del, dryRun, extraArgs, fallback, confirmToken }) =>
      respond(
        (await files.sync({
          source,
          destination,
          delete: del,
          dryRun,
          extraArgs,
          fallback,
          token: confirmToken
        })) as unknown as Record<string, unknown>
      )
  );

  // ---------------------------------------------------------------------------
  // Backup
  // ---------------------------------------------------------------------------
  server.registerTool(
    "backup.create",
    {
      description:
        "Archive a directory into a .tar.gz on the NAS. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        path: z.string().describe("Directory to back up."),
        destinationDir: z.string().describe("Directory to write the archive into."),
        name: z.string().optional().describe("Archive file name (default: timestamped)."),
        confirmToken: tokenField
      }
    },
    async ({ path, destinationDir, name, confirmToken }) =>
      respond(
        (await backup.create({ path, destinationDir, name, token: confirmToken })) as unknown as Record<
          string,
          unknown
        >
      )
  );

  server.registerTool(
    "backup.list",
    {
      description: "List backup archives (*.tar.gz, *.tgz, *.tar, *.zip) in a directory. Read-only.",
      inputSchema: { directory: z.string() }
    },
    async ({ directory }) => respond(await backup.list(directory))
  );

  server.registerTool(
    "backup.verify",
    {
      description: "Check a backup archive exists, compute its checksum, and list its entry count. Read-only.",
      inputSchema: { archive: z.string() }
    },
    async ({ archive }) => respond(await backup.verify(archive))
  );

  server.registerTool(
    "backup.restore",
    {
      description:
        "Extract a .tar.gz archive into a destination directory. Destructive: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: { archive: z.string(), destination: z.string(), confirmToken: tokenField }
    },
    async ({ archive, destination, confirmToken }) =>
      respond(
        (await backup.restore({ archive, destination, token: confirmToken })) as unknown as Record<string, unknown>
      )
  );

  server.registerTool(
    "backup.schedule",
    {
      description:
        "Install a cron job that runs recurring backups. Mutating: returns a dry-run plan unless a confirmation token is supplied.",
      inputSchema: {
        path: z.string().describe("Directory to back up."),
        destinationDir: z.string().describe("Directory to write archives into."),
        cron: z.string().describe("Cron expression, e.g. '0 3 * * *' for 03:00 daily."),
        name: z.string().optional().describe("Job label (default 'backup')."),
        confirmToken: tokenField
      }
    },
    async ({ path, destinationDir, cron, name, confirmToken }) =>
      respond(
        (await backup.schedule({
          path,
          destinationDir,
          cron,
          name,
          token: confirmToken
        })) as unknown as Record<string, unknown>
      )
  );

  // ---------------------------------------------------------------------------
  // Networks
  // ---------------------------------------------------------------------------
  server.registerTool(
    "network.interfaces",
    {
      description: "List host network interfaces with IPv4/IPv6 addresses and scopes. Read-only.",
      inputSchema: {}
    },
    async () => respond({ interfaces: await network.interfaces() })
  );

  server.registerTool(
    "network.routes",
    {
      description: "Show the host IPv4 and IPv6 routing tables. Read-only.",
      inputSchema: {}
    },
    async () => respond(await network.routes())
  );

  server.registerTool(
    "network.ports",
    {
      description: "Show listening TCP/UDP sockets and the processes bound to them. Read-only.",
      inputSchema: {}
    },
    async () => respond({ ports: await network.listeningPorts() })
  );
}
