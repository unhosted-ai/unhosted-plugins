#!/usr/bin/env node
// unhosted-mcp-server
//
// Talks MCP over stdio to a host (Claude Desktop, Zed, Cursor) and
// proxies tool calls to a running unhosted daemon over HTTP. The server
// implements no capabilities itself — every tool maps 1:1 to an
// existing daemon endpoint. Putting MCP in front of the daemon lets
// any MCP-aware host call into the user's local-first machine
// (private memory, sanitized web fetch, cluster status) without each
// host having to learn unhosted's HTTP shape.
//
// Configuration:
// - UNHOSTED_DAEMON_URL  (default: http://127.0.0.1:7777)
// - UNHOSTED_BEARER      (optional; only needed for non-loopback or
//                         when the daemon is reached over the tunnel)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const DAEMON_URL = (process.env.UNHOSTED_DAEMON_URL ?? "http://127.0.0.1:7777").replace(/\/+$/, "");
const BEARER = process.env.UNHOSTED_BEARER;

function authHeaders(): Record<string, string> {
  // Loopback to the local daemon doesn't need auth; the bearer is
  // only required when reaching across the tunnel or from a peer.
  // We always set Content-Type for POSTs; the bearer is added when
  // present.
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (BEARER) headers.authorization = `Bearer ${BEARER}`;
  return headers;
}

// Surface daemon errors as MCP tool errors with the actual body so the
// host model can see what went wrong (404 / 502 / SSRF rejection /
// model-load timeout).
async function callDaemon(method: string, path: string, body?: unknown): Promise<unknown> {
  const resp = await fetch(`${DAEMON_URL}${path}`, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`daemon ${method} ${path} -> ${resp.status}: ${text.slice(0, 400)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Tool registry. Order is the order tools appear when an MCP host
// lists them, which can shape which tool the model reaches for first.
// Put the most-broadly-useful (status, web fetch) ahead of the more
// specialized (memory mutations, vram-pool).
const TOOLS = [
  {
    name: "unhosted_status",
    description:
      "Get the unhosted daemon's current status: node identity, configured upstream, paired peers, discovered LAN peers, vram-pool capability and state, relay status. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_: unknown) {
      return await callDaemon("GET", "/v1/status");
    },
  },
  {
    name: "unhosted_web_fetch",
    description:
      "Fetch a URL through the unhosted daemon and return plain text. HTTPS-only, SSRF-guarded (blocks loopback, RFC1918, link-local, CGNAT, unspecified). Capped at 200 KB. HTML is stripped of script/style and tags. Use when you need recent web content the host model wasn't trained on.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTPS URL to fetch" },
        max_bytes: { type: "integer", description: "optional, defaults to 200000, clamped at that" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async run(input: { url: string; max_bytes?: number }) {
      return await callDaemon("POST", "/v1/tools/web_fetch", input);
    },
  },
  {
    name: "unhosted_memory_list",
    description:
      "List every memory entry stored on the daemon (one per past summarized chat plus any manually-added entries). Each entry has an id, summary text, created_at unix timestamp, and chat_id. Returns whether memory is currently enabled.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_: unknown) {
      return await callDaemon("GET", "/v1/memory");
    },
  },
  {
    name: "unhosted_memory_add",
    description:
      "Add a memory entry. Pass a one-sentence summary describing a persistent fact about the user (their role, preferences, projects). The daemon will inject this and other relevant memories into the system prompt of future chats. Requires memory to be enabled by the user.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        chat_id: { type: "string", description: "optional, links the memory to a source chat id" },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    async run(input: { summary: string; chat_id?: string | null }) {
      return await callDaemon("POST", "/v1/memory", input);
    },
  },
  {
    name: "unhosted_memory_delete",
    description: "Remove a single memory entry by id. The id comes from unhosted_memory_list.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async run(input: { id: string }) {
      await callDaemon("DELETE", `/v1/memory/${encodeURIComponent(input.id)}`);
      return { deleted: input.id };
    },
  },
  {
    name: "unhosted_vram_pool_status",
    description:
      "Get the current VRAM-pool state: idle, starting (with stage), running (with endpoint + plan), failed (with error), or hosting (this machine is a layer host for a remote orchestrator). Read-only — use unhosted_status for capability discovery.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_: unknown) {
      return await callDaemon("GET", "/v1/vram-pool");
    },
  },
] as const;

type Tool = (typeof TOOLS)[number];

const server = new Server(
  {
    name: "unhosted",
    version: "0.0.1",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name) as Tool | undefined;
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const result = await tool.run((req.params.arguments ?? {}) as never);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
});

// Run forever. stdio transport keeps the process alive while the MCP
// host has the stdio pipes open; the host signals shutdown by closing
// stdin, at which point this resolves and we exit.
const transport = new StdioServerTransport();
await server.connect(transport);
