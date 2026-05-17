# unhosted-mcp-server

[MCP](https://modelcontextprotocol.io/) server that exposes a running unhosted daemon's local-first capabilities as MCP tools. Plug it into Claude Desktop, Zed, Cursor, or any MCP-aware client to give the host model a `unhosted_*` toolset that calls into your local daemon.

## What it exposes

Each unhosted daemon HTTP endpoint becomes one MCP tool:

| MCP tool | Daemon endpoint | What it does |
| --- | --- | --- |
| `unhosted_web_fetch` | `POST /v1/tools/web_fetch` | Fetch a URL through the daemon. SSRF-guarded, capped at 200 KB, HTTPS-only. Returns plain-text content. |
| `unhosted_memory_list` | `GET /v1/memory` | List all stored memory entries. |
| `unhosted_memory_add` | `POST /v1/memory` | Add a memory entry. |
| `unhosted_memory_delete` | `DELETE /v1/memory/{id}` | Remove a memory entry. |
| `unhosted_vram_pool_status` | `GET /v1/vram-pool` | Current cluster state (idle / starting / running / hosting). |
| `unhosted_status` | `GET /v1/status` | Daemon + upstream + peer + cluster summary. |

The MCP server is a thin stdio wrapper — it doesn't reimplement any of these capabilities, it just proxies. All the actual logic (SSRF guards, memory storage, vram-pool orchestration) stays in the unhosted daemon where it's already tested.

## Requires

- A running unhosted daemon ≥ v0.0.25 (when `/v1/tools/web_fetch` shipped).
- Node.js ≥ 20.

## Install

```sh
npm install -g @unhosted-ai/mcp-server   # not published yet — see "Develop" below
```

Then in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or wherever your MCP host loads its config:

```json
{
  "mcpServers": {
    "unhosted": {
      "command": "unhosted-mcp-server",
      "env": { "UNHOSTED_DAEMON_URL": "http://127.0.0.1:7777" }
    }
  }
}
```

## Develop

```sh
cd mcp-server
npm install
npm run build     # tsc into dist/
node dist/index.js
```

The server speaks MCP over stdio. Easiest local test is to drive it via the `@modelcontextprotocol/inspector` tool:

```sh
npx @modelcontextprotocol/inspector node dist/index.js
```

## License

AGPL-3.0-or-later, matching the daemon.
