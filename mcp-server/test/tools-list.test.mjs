// Integration test: boot a fake daemon, spawn the MCP server pointed
// at it, do the MCP init handshake, list tools, assert the six we
// ship come back. Exercises:
//   - stdio JSON-RPC framing (the SDK's StdioClientTransport handles)
//   - the SDK's initialize/initialized handshake
//   - our ListToolsRequestSchema handler in src/index.ts
//
// We don't exercise CallTool here — that would require a much more
// elaborate fake daemon. A follow-up test can add per-tool calls
// once the daemon's HTTP shape stabilizes further.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "dist", "index.js");

const EXPECTED_TOOLS = [
  "unhosted_status",
  "unhosted_web_fetch",
  "unhosted_memory_list",
  "unhosted_memory_add",
  "unhosted_memory_delete",
  "unhosted_vram_pool_status",
];

let fakeDaemon;
let fakeDaemonUrl;

before(async () => {
  // Minimal stand-in for an unhosted daemon. Returns trivially-valid
  // JSON for the read-only endpoints the MCP tools list expects.
  // `tools/list` doesn't actually hit the daemon, but the MCP server
  // doesn't know that until a tool is *called*, so we set this up to
  // be defensive in case the SDK probes anything during init.
  fakeDaemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise((resolve_) => fakeDaemon.listen(0, "127.0.0.1", resolve_));
  const { port } = fakeDaemon.address();
  fakeDaemonUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((r) => fakeDaemon.close(r));
});

describe("MCP server: tools/list", () => {
  it("lists exactly the six tools we ship", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, // node
      args: [SERVER_PATH],
      env: { ...process.env, UNHOSTED_DAEMON_URL: fakeDaemonUrl },
    });

    const client = new Client(
      { name: "unhosted-mcp-server-tests", version: "0.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const res = await client.listTools();
      const names = res.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [...EXPECTED_TOOLS].sort());

      // Every tool must have a description and inputSchema — Claude
      // Desktop won't show tools that lack these.
      for (const t of res.tools) {
        assert.ok(typeof t.description === "string" && t.description.length > 0,
          `tool ${t.name} missing description`);
        assert.ok(t.inputSchema && typeof t.inputSchema === "object",
          `tool ${t.name} missing inputSchema`);
      }
    } finally {
      await client.close();
    }
  });
});
