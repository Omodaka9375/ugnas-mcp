// Verifies the optional Streamable-HTTP transport: boots the server with
// UGNAS_HTTP_PORT set, then checks /health and a JSON-RPC initialize over POST /mcp.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "src", "server.js");

const dir = mkdtempSync(join(tmpdir(), "ugnas-http-"));
const configPath = join(dir, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({ host: "127.0.0.1", username: "smoke", auth: { type: "password", password: "x" } })
);

const port = 4110;
const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, UGNAS_MCP_CONFIG: configPath, UGNAS_HTTP_PORT: String(port) },
  stdio: ["pipe", "pipe", "inherit"]
});

const base = `http://127.0.0.1:${port}`;

async function waitForServer(attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  if (!(await waitForServer())) {
    throw new Error("HTTP transport did not become ready");
  }

  const health = await (await fetch(`${base}/health`)).json();
  console.log("HEALTH:", JSON.stringify(health));

  const initRes = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" }
      }
    })
  });
  const text = await initRes.text();
  console.log("INITIALIZE STATUS:", initRes.status);
  console.log("INITIALIZE BODY:", text.slice(0, 200).replace(/\s+/g, " "));
  console.log(text.includes("ugnas-mcp") ? "HTTP OK" : "HTTP UNEXPECTED");
} finally {
  child.kill();
}
