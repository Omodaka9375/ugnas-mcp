#!/usr/bin/env node
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as httpServerType
} from "node:http";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadNasConfig } from "./config.js";
import { createMcpServer } from "./mcp/createServer.js";
import { ConfirmationTokenService } from "./safety/plan.js";
import type { ServiceContext } from "./services/context.js";
import { SshExecutor } from "./ssh/sshExecutor.js";

export function buildContext(): ServiceContext {
  const config = loadNasConfig();
  const executor = new SshExecutor(config);
  const confirmations = new ConfirmationTokenService();
  return { config, executor, confirmations };
}

export type HttpOptions = {
  host: string;
  port: number;
};

/** Read transport options from the environment; HTTP is opt-in via UGNAS_HTTP_PORT. */
export function httpOptions(env: NodeJS.ProcessEnv = process.env): HttpOptions | null {
  const port = Number(env.UGNAS_HTTP_PORT);
  if (!env.UGNAS_HTTP_PORT || !Number.isFinite(port) || port <= 0) {
    return null;
  }
  const host = env.UGNAS_HTTP_HOST ?? "127.0.0.1";
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  // The HTTP transport has NO authentication, and confirmation tokens are
  // process-wide — binding beyond loopback would hand full (destructive) NAS
  // control to anyone who can reach the port. Require an explicit opt-in.
  if (!isLoopback && env.UGNAS_HTTP_ALLOW_REMOTE !== "1") {
    throw new Error(
      `Refusing to bind HTTP transport to ${host}: /mcp has no authentication. ` +
        `Set UGNAS_HTTP_ALLOW_REMOTE=1 only if the port is secured by something else (VPN/reverse proxy with auth).`
    );
  }
  return { host, port };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const MAX_BODY_BYTES = 1024 * 1024;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body exceeds the 1 MiB limit");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

function startHttpTransport(ctx: ServiceContext, options: HttpOptions): httpServerType {
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttpRequest(ctx, req, res);
  });

  server.listen(options.port, options.host, () => {
    process.stderr.write(
      `ugnas-mcp: HTTP transport listening on http://${options.host}:${options.port}/mcp\n`
    );
  });
  return server;
}

async function handleHttpRequest(
  ctx: ServiceContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = req.url ?? "/";

  if (url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", host: `${ctx.config.host}:${ctx.config.port}` }));
    return;
  }

  if (url !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  if (req.method !== "POST") {
    // Stateless mode: no GET stream or DELETE sessions to manage.
    res.writeHead(405, { "content-type": "application/json", allow: "POST" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Use POST." },
        id: null
      })
    );
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = await readJsonBody(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message }, id: null }));
    return;
  }

  // A fresh server + stateless transport per request keeps concurrent clients isolated.
  const mcpServer = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ugnas-mcp: HTTP request failed: ${message}\n`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        })
      );
    }
  } finally {
    await transport.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const ctx = buildContext();

  const stdioServer = createMcpServer(ctx);
  const stdioTransport = new StdioServerTransport();
  await stdioServer.connect(stdioTransport);

  const options = httpOptions();
  const httpServer = options ? startHttpTransport(ctx, options) : null;

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Without an explicit exit, registered signal handlers suppress Node's
    // default termination and the process would hang after Ctrl+C.
    ctx.executor.close();
    httpServer?.close();
    void stdioServer.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ugnas-mcp failed to start: ${message}\n`);
  process.exit(1);
});
