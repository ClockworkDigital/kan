import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const folder = mkdtempSync(join(tmpdir(), "kan-mcp-"));
const filename = join(folder, "credential.json");
const command = [resolve("deploy/formwork/mcp.cjs"), filename];
const config = { baseUrl: "https://kan.example.test", apiToken: "kan_mcp_" + "a".repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString() };
try {
  writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const client = new Client({ name: "kan-wrapper-check", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: command }));
    const tools = await client.listTools();
    assert(tools.tools.some((tool) => tool.name === "list_workspaces"));
  } finally {
    await client.close();
  }
  chmodSync(filename, 0o644);
  let result = spawnSync(process.execPath, command, { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert(!result.stderr.includes(config.apiToken));
  chmodSync(filename, 0o600);
  writeFileSync(filename, JSON.stringify({ ...config, expiresAt: "2000-01-01T00:00:00Z" }));
  result = spawnSync(process.execPath, command, { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert(!result.stderr.includes(config.apiToken));
  writeFileSync(filename, JSON.stringify({ ...config, baseUrl: "http://kan.example.test" }));
  assert.equal(spawnSync(process.execPath, command).status, 1);
  console.log("PASS MCP stdio handshake, tool discovery, private-file enforcement and expired/insecure credential rejection.");
} finally {
  rmSync(folder, { recursive: true, force: true });
}
