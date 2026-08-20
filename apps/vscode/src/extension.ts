import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  console.log("ForgeAI extension is activating...");

  const disposable = vscode.commands.registerCommand("forgeai.startTask", async () => {
    const input = await vscode.window.showInputBox({
      prompt: "Describe the coding task for ForgeAI",
      placeHolder: "e.g., Add error handling to the login function",
    });

    if (!input) {
      return;
    }

    const config = vscode.workspace.getConfiguration("forgeai");
    const serverUrl = config.get<string>("serverUrl", "http://127.0.0.1:4141");

    vscode.window.showInformationMessage(`Starting ForgeAI task: ${input}`);

    const panel = vscode.window.createWebviewPanel(
      "forgeai.chat",
      "ForgeAI",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    panel.webview.html = getWebviewHtml();

    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === "startTask") {
          try {
            const response = await fetch(`${serverUrl}/api/agent/run`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                task: message.task,
                config: {
                  provider: {
                    type: config.get<string>("provider.type", "gemini"),
                    model: config.get<string>("provider.model", "gemini-pro"),
                  },
                  workspaceRoot: vscode.workspace.rootPath || "",
                  permissionPolicy: {
                    rules: [],
                    defaultLevel: "approval",
                  },
                  maxIterations: 10,
                  contextWindowLimit: 100000,
                },
              }),
            });

            if (!response.ok) {
              panel.webview.postMessage({ type: "error", text: `Server error: ${response.statusText}` });
              return;
            }

            const reader = response.body?.getReader();
            if (!reader) {
              panel.webview.postMessage({ type: "error", text: "No response stream." });
              return;
            }

            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]") {
                  panel.webview.postMessage({ type: "complete" });
                  return;
                }
                try {
                  const event = JSON.parse(data);
                  panel.webview.postMessage({ type: "event", event });
                } catch {
                  // ignore parse errors
                }
              }
            }
          } catch (error) {
            panel.webview.postMessage({ type: "error", text: String(error) });
          }
        }
      },
      undefined,
      context.subscriptions
    );

    panel.webview.postMessage({ type: "status", text: "Ready" });
  });

  const cancelDisposable = vscode.commands.registerCommand("forgeai.cancelTask", async () => {
    try {
      const response = await fetch(`${vscode.workspace.getConfiguration("forgeai").get<string>("serverUrl", "http://127.0.0.1:4141")}/api/agent/cancel`, {
        method: "POST",
      });
      const result = await response.json() as { status: string };
      vscode.window.showInformationMessage(`ForgeAI cancel: ${result.status}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to cancel: ${String(error)}`);
    }
  });

  context.subscriptions.push(disposable, cancelDisposable);
}

export function deactivate() {
  console.log("ForgeAI extension deactivating...");
}

function getWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ForgeAI</title>
<style>
  body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .header { font-size: 18px; font-weight: 600; margin-bottom: 12px; }
  .log { background: var(--vscode-textBlockQuote-background); padding: 8px; border-radius: 4px; margin-bottom: 8px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .error { color: var(--vscode-errorForeground); }
  input { width: 100%; padding: 8px; margin-bottom: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
  button { padding: 8px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>
  <div class="header">ForgeAI Agent</div>
  <input id="task" type="text" placeholder="Describe your coding task..." />
  <button id="run">Run</button>
  <div id="output"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const output = document.getElementById('output');
    const taskInput = document.getElementById('task');
    const runBtn = document.getElementById('run');

    runBtn.addEventListener('click', () => {
      const task = taskInput.value.trim();
      if (!task) return;
      output.innerHTML = '';
      vscode.postMessage({ command: 'startTask', task });
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'event') {
        const el = document.createElement('div');
        el.className = 'log';
        const eventData = msg.event;
        if (eventData.type === 'step') {
          const statusIcon = eventData.step.status === 'completed' ? '[OK]' : eventData.step.status === 'failed' ? '[FAIL]' : eventData.step.status === 'cancelled' ? '[CANCEL]' : '[RUN]';
          el.textContent = statusIcon + ' [' + eventData.step.type + '] ' + eventData.step.description + ' - ' + eventData.step.status;
        } else if (eventData.type === 'message') {
          el.textContent = '[MSG] ' + eventData.message.content;
        } else if (eventData.type === 'state') {
          const state = eventData.state;
          el.textContent = '[STATE] ' + state.status + ' | Steps: ' + state.steps.length + ' | Context: ' + state.contextFiles.length + ' files';
        } else {
          el.textContent = JSON.stringify(eventData, null, 2);
        }
        output.appendChild(el);
        output.scrollTop = output.scrollHeight;
      } else if (msg.type === 'error') {
        const el = document.createElement('div');
        el.className = 'log error';
        el.textContent = '[ERROR] ' + msg.text;
        output.appendChild(el);
        output.scrollTop = output.scrollHeight;
      } else if (msg.type === 'complete') {
        const el = document.createElement('div');
        el.className = 'log';
        el.textContent = '[DONE] Agent run finished.';
        output.appendChild(el);
        output.scrollTop = output.scrollHeight;
      } else if (msg.type === 'status') {
        const el = document.createElement('div');
        el.className = 'log';
        el.textContent = '[INFO] ' + msg.text;
        output.appendChild(el);
        output.scrollTop = output.scrollHeight;
      }
    });
  </script>
</body>
</html>`;
}
