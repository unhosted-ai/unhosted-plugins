// unhosted VS Code extension.
//
// Talks to a running unhosted daemon (default http://127.0.0.1:7777)
// over its OpenAI-compatible HTTP API. Everything stays on the user's
// machines: the daemon serves whatever local model is loaded (built-in
// model library, llama.cpp, Ollama, or LM Studio behind the same URL).
//
// Surface:
//  - status bar item: daemon reachability + served model, polls /v1/status
//  - "unhosted: Open Chat" — webview chat panel with streaming replies
//  - "unhosted: Explain Selection" / "Ask About Selection" — editor
//    context-menu commands that route the selection through the chat panel
//  - "unhosted: Check Daemon Status" — one-shot diagnostic notification

import * as vscode from "vscode";

// ─── daemon client ─────────────────────────────────────────────────────────

interface DaemonConfig {
  baseUrl: string;
  bearerToken: string;
  maxTokens: number;
}

function config(): DaemonConfig {
  const c = vscode.workspace.getConfiguration("unhosted");
  return {
    baseUrl: (c.get<string>("baseUrl") || "http://127.0.0.1:7777").replace(/\/+$/, ""),
    bearerToken: c.get<string>("bearerToken") || "",
    maxTokens: c.get<number>("maxTokens") || 1024,
  };
}

function headers(cfg: DaemonConfig): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cfg.bearerToken) h.authorization = `Bearer ${cfg.bearerToken}`;
  return h;
}

interface DaemonStatus {
  reachable: boolean;
  model?: string;
  upstream?: string;
  error?: string;
}

async function fetchStatus(): Promise<DaemonStatus> {
  const cfg = config();
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/status`, {
      headers: headers(cfg),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { model?: string; upstream?: string };
    return { reachable: true, model: body.model, upstream: body.upstream };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/// Stream a chat completion; calls onDelta per content chunk.
/// Returns the full assistant text.
async function streamChat(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const cfg = config();
  const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ messages, max_tokens: cfg.maxTokens, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as { error?: { message?: string } | string };
      const msg = typeof err.error === "string" ? err.error : err.error?.message;
      if (msg) detail = msg;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // OpenAI-style SSE: lines of `data: {...}` terminated by `data: [DONE]`.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return full;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        /* keep-alive or partial frame — ignore */
      }
    }
  }
  return full;
}

// ─── chat panel ────────────────────────────────────────────────────────────

class ChatPanel {
  static current: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private messages: ChatMessage[] = [];
  private inflight: AbortController | undefined;

  static show(context: vscode.ExtensionContext): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return ChatPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "unhostedChat",
      "unhosted",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ChatPanel.current = new ChatPanel(panel, context);
    return ChatPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    panel.webview.html = chatHtml();
    panel.onDidDispose(() => {
      this.inflight?.abort();
      ChatPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(
      async (msg: { type: string; text?: string }) => {
        if (msg.type === "send" && msg.text) await this.ask(msg.text);
        if (msg.type === "stop") this.inflight?.abort();
      },
      undefined,
      context.subscriptions,
    );
  }

  /// Send one user turn through the daemon, streaming into the webview.
  async ask(text: string): Promise<void> {
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    this.messages.push({ role: "user", content: text });
    this.post({ type: "user", text });
    this.post({ type: "assistant-start" });
    try {
      const full = await streamChat(
        this.messages,
        (delta) => this.post({ type: "assistant-delta", text: delta }),
        controller.signal,
      );
      this.messages.push({ role: "assistant", content: full });
      this.post({ type: "assistant-done" });
    } catch (e) {
      const aborted = controller.signal.aborted;
      this.post({
        type: "assistant-error",
        text: aborted ? "[stopped]" : `daemon error: ${e instanceof Error ? e.message : e}`,
      });
      // Keep history consistent: drop the user turn that failed so a
      // retry doesn't double it.
      if (!aborted) this.messages.pop();
    } finally {
      if (this.inflight === controller) this.inflight = undefined;
    }
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }
}

/// Self-contained webview: no external resources, CSP locked to the
/// extension's own inline script. Renders plain text — code fences get
/// a monospace block, nothing is interpreted as HTML.
function chatHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: 12px; }
  .turn { margin-bottom: 12px; white-space: pre-wrap; word-break: break-word; }
  .turn .who { font-size: 11px; opacity: 0.65; margin-bottom: 3px; text-transform: lowercase; }
  .turn.user .body { background: var(--vscode-input-background); border-radius: 6px; padding: 8px 10px; }
  .turn.error .body { color: var(--vscode-errorForeground); }
  form { display: flex; gap: 6px; padding: 10px; border-top: 1px solid var(--vscode-panel-border); }
  textarea { flex: 1; resize: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px 8px; font: inherit; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 0 14px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <div id="log"></div>
  <form id="composer">
    <textarea id="prompt" rows="2" placeholder="ask your local model… (enter to send, shift+enter for newline)"></textarea>
    <button type="submit" id="send">send</button>
  </form>
<script>
  const vscode = acquireVsCodeApi();
  const log = document.getElementById("log");
  const form = document.getElementById("composer");
  const prompt = document.getElementById("prompt");
  const sendBtn = document.getElementById("send");
  let streamingBody = null;

  function turn(who, cls) {
    const div = document.createElement("div");
    div.className = "turn " + cls;
    const whoEl = document.createElement("div");
    whoEl.className = "who";
    whoEl.textContent = who;
    const body = document.createElement("div");
    body.className = "body";
    div.appendChild(whoEl);
    div.appendChild(body);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return body;
  }

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m.type === "user") { turn("you", "user").textContent = m.text; }
    if (m.type === "assistant-start") { streamingBody = turn("unhosted", "assistant"); sendBtn.textContent = "stop"; }
    if (m.type === "assistant-delta" && streamingBody) { streamingBody.textContent += m.text; log.scrollTop = log.scrollHeight; }
    if (m.type === "assistant-done") { streamingBody = null; sendBtn.textContent = "send"; }
    if (m.type === "assistant-error") {
      const body = streamingBody || turn("unhosted", "assistant");
      body.parentElement.classList.add("error");
      body.textContent += (body.textContent ? "\\n" : "") + m.text;
      streamingBody = null;
      sendBtn.textContent = "send";
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (sendBtn.textContent === "stop") { vscode.postMessage({ type: "stop" }); return; }
    const text = prompt.value.trim();
    if (!text) return;
    prompt.value = "";
    vscode.postMessage({ type: "send", text });
  });
  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
</script>
</body>
</html>`;
}

// ─── selection commands ────────────────────────────────────────────────────

function selectionContext(): { text: string; language: string } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("unhosted: select some code first.");
    return undefined;
  }
  return {
    text: editor.document.getText(editor.selection),
    language: editor.document.languageId,
  };
}

async function explainSelection(context: vscode.ExtensionContext): Promise<void> {
  const sel = selectionContext();
  if (!sel) return;
  const panel = ChatPanel.show(context);
  await panel.ask(
    `Explain what this ${sel.language} code does, briefly:\n\n\`\`\`${sel.language}\n${sel.text}\n\`\`\``,
  );
}

async function askAboutSelection(context: vscode.ExtensionContext): Promise<void> {
  const sel = selectionContext();
  if (!sel) return;
  const question = await vscode.window.showInputBox({
    prompt: "unhosted: what do you want to know about the selection?",
    placeHolder: "e.g. why might this leak memory?",
  });
  if (!question) return;
  const panel = ChatPanel.show(context);
  await panel.ask(
    `${question}\n\n\`\`\`${sel.language}\n${sel.text}\n\`\`\``,
  );
}

// ─── status bar ────────────────────────────────────────────────────────────

function startStatusBar(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  item.command = "unhosted.openChat";
  item.text = "$(circle-outline) unhosted";
  item.tooltip = "unhosted daemon — checking…";
  item.show();
  context.subscriptions.push(item);

  const refresh = async () => {
    const s = await fetchStatus();
    if (s.reachable) {
      item.text = "$(circle-filled) unhosted";
      item.tooltip = `unhosted daemon: online${s.model ? ` — serving ${s.model}` : ""}\nclick to chat`;
    } else {
      item.text = "$(circle-outline) unhosted";
      item.tooltip = `unhosted daemon: offline (${s.error ?? "unreachable"})\nstart the unhosted app, then click to chat`;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 15000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

// ─── activation ────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("unhosted.openChat", () => ChatPanel.show(context)),
    vscode.commands.registerCommand("unhosted.explainSelection", () => explainSelection(context)),
    vscode.commands.registerCommand("unhosted.askAboutSelection", () => askAboutSelection(context)),
    vscode.commands.registerCommand("unhosted.checkStatus", async () => {
      const s = await fetchStatus();
      if (s.reachable) {
        void vscode.window.showInformationMessage(
          `unhosted: online${s.model ? ` — serving ${s.model}` : ""} (${config().baseUrl})`,
        );
      } else {
        void vscode.window.showWarningMessage(
          `unhosted: daemon unreachable at ${config().baseUrl} — ${s.error ?? "is the app running?"}`,
        );
      }
    }),
  );
  startStatusBar(context);
}

export function deactivate(): void {
  /* subscriptions dispose via context */
}
