# unhosted — VS Code extension

Chat with your [unhosted](https://github.com/unhosted-ai/unhosted-core) daemon without leaving the editor. Your hardware, your models — prompts never leave your machines.

## What you get

- **Status bar indicator** — filled dot when the daemon is reachable, with the currently served model in the tooltip. Click it to chat.
- **`unhosted: Open Chat`** — a chat panel beside your editor with streaming replies from whatever model the daemon serves (built-in model library, llama.cpp, Ollama, or LM Studio).
- **Right-click → `unhosted: Explain Selection`** — sends the selected code to your local model.
- **Right-click → `unhosted: Ask About Selection`** — same, but you type the question.
- **`unhosted: Check Daemon Status`** — one-shot diagnostic.

## Requirements

A running unhosted daemon (the desktop app, or `unhosted serve`) with a model loaded — settings → compute → models in the unhosted UI is the fastest path. Daemon v0.0.76+ recommended.

## Install

Until the Marketplace listing ships, install from a local build:

```bash
cd vscode-extension
npm install
npm run build
npm run package          # produces unhosted-vscode-<version>.vsix
code --install-extension unhosted-vscode-*.vsix
```

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `unhosted.baseUrl` | `http://127.0.0.1:7777` | Daemon URL. Point at a LAN peer or tunnel URL to use a remote node. |
| `unhosted.bearerToken` | _(empty)_ | Required for non-loopback daemons. Copy it from the unhosted UI: settings → for developers → api access. |
| `unhosted.maxTokens` | `1024` | `max_tokens` per completion. |

## Daemon endpoints used

- `GET /v1/status` — status bar + diagnostics
- `POST /v1/chat/completions` (`stream: true`) — chat

## Develop

```bash
npm install
npm run watch
```

Then `F5` in VS Code (Run Extension launch target) for an Extension Development Host.
