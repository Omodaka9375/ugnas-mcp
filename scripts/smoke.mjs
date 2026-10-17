// Minimal MCP stdio handshake smoke test: boots the built server, runs
// initialize + tools/list, prints the tool names, and exits.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "src", "server.js");

const dir = mkdtempSync(join(tmpdir(), "ugnas-smoke-"));
const configPath = join(dir, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({
    host: "127.0.0.1",
    username: "smoke",
    auth: { type: "password", password: "x" }
  })
);

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, UGNAS_MCP_CONFIG: configPath },
  stdio: ["pipe", "pipe", "pipe"]
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
let buffer = "";
const seen = [];

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    }
    if (msg.id === 2) {
      const names = (msg.result?.tools ?? []).map((t) => t.name).sort();
      seen.push(...names);
      console.log(`TOOL COUNT: ${names.length}`);
      console.log(names.join("\n"));
      child.kill();
      process.exit(0);
    }
  }
});

child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" }
  }
});

setTimeout(() => {
  console.error("Smoke test timed out");
  child.kill();
  process.exit(1);
}, 15000);
