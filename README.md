# unhosted-plugins

Plugins, extensions, and integrations that talk to a running [unhosted](https://github.com/unhosted-ai/unhosted-core) daemon.

Lives in its own repo so the core daemon stays small and plugin work doesn't block daemon releases (or vice versa). Each plugin lives in its own directory at the top level. A plugin can be in any language — what makes it a "plugin" is just that it talks to `http://127.0.0.1:7777` (or the user's configured daemon URL) over the documented HTTP API.

## Current plugins

| Directory | What it is | Status | Language |
| --- | --- | --- | --- |
| [`mcp-server/`](./mcp-server) | Exposes unhosted's local capabilities (memory, web fetch, vram-pool status) as MCP tools so MCP-aware clients (Claude Desktop, IDE extensions) can call into the daemon. | scaffolded | TypeScript |

Planned (not started):

- `browser-extension/` — Chrome/Safari/Firefox extension that puts an "AI" button on every text field and routes the prompt through the local daemon. (May or may not happen — [Delta](https://github.com/Delta-Practice/Browser) already covers this.)

## Adding a new plugin

1. Create a top-level directory named for the plugin.
2. Drop a `README.md` with: what it does, how to install, how to develop, what daemon endpoints it depends on.
3. Pick whatever language fits the host runtime (TypeScript for MCP-host stdio, Swift for a macOS menu-bar extra, Rust for anything that wants to share types with the daemon — currently nothing forces a particular choice).
4. Submit a PR.

## Versioning

Each plugin versions independently. Plugins should declare which daemon version they require in their own README. The repo as a whole has no global version — `git log` is the source of truth.

## License

Plugins inherit the project's license — AGPL-3.0-or-later — unless the plugin's own `LICENSE` says otherwise (e.g., a TypeScript plugin that wants MIT to align with the npm ecosystem).
