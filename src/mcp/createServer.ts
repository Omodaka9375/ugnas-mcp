import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "./toolset.js";
import type { ServiceContext } from "../services/context.js";

export const SERVER_NAME = "ugnas-mcp";
export const SERVER_VERSION = "0.1.1";

export function createMcpServer(ctx: ServiceContext): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  registerTools(server, ctx);
  return server;
}
