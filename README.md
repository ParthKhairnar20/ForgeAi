# ForgeAI

ForgeAI is a personal coding agent that lives inside VS Code. It reads your repository, reasons about coding tasks, and uses built-in tools to make changes — all powered by local LLMs via Gemini or OpenRouter.

## Current Architecture

```
VS Code Extension
    ↓ (task only, no API keys)
ForgeAI Server (Fastify, port 4141)
    ↓
Agent Loop
    ↓
ModelRouter
    ↓
Primary Provider: Gemini (GEMINI_API_KEY env var)
    ↓ (fallback on failure)
Fallback Provider: OpenRouter (OPENROUTER_API_KEY env var)
```

## Current Capabilities

- **7 built-in tools**: `read_file`, `write_file`, `list_files`, `search_files`, `run_command`, `git_status`, `git_diff`
- **Structured tool results**: every tool returns a typed result with stable machine-readable error codes (`ToolErrorCode`), human-readable messages, a `recoverable` flag, and metadata (duration, exit code, bytes read/written)
- **Context discovery**: keyword + symbol-based file ranking with sensitive file exclusion
- **Streaming responses**: real-time SSE from model to VS Code webview
- **Model fallback**: Gemini → OpenRouter automatic fallback on failure
- **Cancellation**: cancel running tasks from VS Code
- **Self-correction**: agent retries with corrected actions when tools fail
- **Security**: path traversal prevention, sensitive file exclusion, command destructive-pattern blocklist
- **Command hardening**: per-stream 100 KB output limits, 30 s timeout with process kill, cancellation-aware child process termination, structured error classification
- **Tool output pagination**: large tool outputs are returned in bounded pages with opaque continuation cursors instead of being discarded (see below)

## Command Execution (run_command)

`run_command` executes shell commands inside the workspace with the following behavior:

| Aspect | Behavior |
|--------|----------|
| **Windows** | Commands run through `powershell.exe -NoProfile -NonInteractive`. Exit codes are propagated via `exit $LASTEXITCODE`; output formatting is forced synchronous via `Out-String`. |
| **Linux/macOS** | Commands are tokenized and executed directly via `spawn` (no shell). |
| **stdout / stderr** | Captured separately and returned in distinct `--- stdout ---` / `--- stderr ---` sections. stderr alone does not fail a command if the exit code is 0. |
| **Exit codes** | Non-zero exit → `COMMAND_FAILED` error with `metadata.exitCode`. Unknown commands → `COMMAND_NOT_FOUND`. |
| **Output limit** | Each stream is capped at 100 KB. Excess output is discarded and `metadata.truncated: true` is set. This prevents huge command output from consuming the agent context. |
| **Timeout** | Commands are killed after 30 seconds (configurable via `FORGEAI_COMMAND_TIMEOUT_MS` env var) and return a `TIMEOUT` error. The child process is killed with SIGKILL to avoid orphans. |
| **Cancellation** | Agent cancellation kills the running child process immediately and returns a `CANCELLED` error (distinct from `TIMEOUT` and `COMMAND_FAILED`). |

### Command parsing limitations

Commands are tokenized respecting double/single quotes (e.g. `node -e "console.log('x')"` works). Known limitations:

- Escaped quotes inside quoted segments (`"`) are not supported.
- Shell operators (`&&`, `||`, pipes, redirection) are not interpreted — each command runs as a single program invocation.
- Mixed quoting edge cases may differ slightly from native shell parsing.

## Tool Output Pagination

Large tool outputs no longer get discarded after the resource limit — they are returned as bounded pages that the agent can consume incrementally.

| Tool | Page unit | First page bound |
|------|-----------|------------------|
| `run_command` | bytes of formatted stdout/stderr output | 16 KB |
| `read_file` | lines (max 400 lines or 64 KB per page) | 64 KB |
| `search_files` | result items | 50 matches |
| `list_files` | directory entries | 100 entries |
| `git_status` / `git_diff` | bytes of git output | 16 KB |

How it works:

1. The first response contains only a bounded page plus `metadata.pagination = { page, pageSize, hasMore: true, nextCursor }`.
2. To fetch more, the agent calls the same tool again with `{ "cursor": "<nextCursor>" }`.
3. Cursors are **opaque random tokens** — they carry no paths, commands, or data.
4. Cursors are **single-use**: each fetch consumes the token and issues a fresh one for the remainder. Replaying a cursor returns an `INVALID_CURSOR` error.
5. The final page reports `hasMore: false` with no cursor.

Resource and security guarantees:

- **Filtering before pagination**: sensitive-file exclusion, workspace-boundary checks, and search filtering always run BEFORE pages are created. A later page can never bypass security — page 2 is never "raw" data.
- **read_file continuations re-validate everything**: the stored file path is re-checked against workspace boundaries, binary detection, and sensitive-file patterns on every page request; user-supplied paths are ignored on continuations.
- **Bounded memory**: command output capture remains capped at 100 KB/stream (buffered up to 1 MB for pagination); files are read incrementally in ~64 KB chunks without loading the whole file; search results are capped at 2000 matches; listings at 5000 entries.
- **Loop protection**: the agent may make at most 10 cursor-based page requests per task; beyond that it receives a structured `INVALID_CURSOR` error telling it to work with what it has.
- **Pagination state**: held in memory only, max 50 active cursors with a 15-minute TTL.

### Command safety limitations

Command execution is **not a full sandbox**. A small blocklist blocks clearly destructive commands (`rm -rf`, `del /f`, `rmdir`, `rd /s`, `format`, `mkfs`, `shutdown`, `restart`, `diskpart`, fork bombs), but arbitrary non-blocklisted commands can still modify files within (or outside, subject to OS permissions) the workspace. Only run ForgeAI on trusted workspaces.

## Current Limitations

- Single-agent only (no multi-agent orchestration)
- No persistent memory or database
- No vector search / embeddings
- Context discovery is file-level (no AST-aware yet)
- OpenRouter/Groq/Ollama are partially implemented
- Windows requires Visual Studio C++ build tools for some optional dependencies

## Requirements

- **Node.js**: >= 18.0.0 (native `fetch` required)
- **pnpm**: 8.15.0 (recommended) or compatible
- **OS**: Windows, macOS, or Linux
- **VS Code**: >= 1.80.0 (for extension development)

## Windows Setup

```powershell
# Install Node.js from https://nodejs.org/
# Verify installation
node --version   # should be >= 18.0.0

# Install pnpm
npm install -g pnpm

# Verify pnpm
pnpm --version
```

## Installation

```powershell
# Clone the repository
git clone <repository-url>
cd Forge-Ai

# Install dependencies
pnpm install
```

## Provider Configuration

ForgeAI reads API keys from **server-side environment variables**. The VS Code extension never sends API keys to the server.

### Gemini

```powershell
# PowerShell
$env:GEMINI_API_KEY = "your-gemini-api-key"
```

```bash
# Git Bash / WSL
export GEMINI_API_KEY="your-gemini-api-key"
```

### OpenRouter

```powershell
# PowerShell
$env:OPENROUTER_API_KEY = "your-openrouter-api-key"
```

```bash
# Git Bash / WSL
export OPENROUTER_API_KEY="your-openrouter-api-key"
```

## Provider Configuration in VS Code

Open VS Code settings (`Ctrl+,`) and search for `forgeai`:

| Setting | Default | Description |
|---------|---------|-------------|
| `forgeai.serverUrl` | `http://127.0.0.1:4141` | ForgeAI server URL |
| `forgeai.provider.type` | `gemini` | Provider: `gemini`, `openrouter`, `mock` |
| `forgeai.provider.model` | `gemini-3.6-flash` | Model name (provider-specific) |

## Starting the Server

```powershell
# Development mode (with hot reload if configured)
pnpm --filter @forgeai/server run dev

# Or directly
node apps/server/dist/index.js
```

Server runs at `http://127.0.0.1:4141`.

## Launching VS Code Extension

1. Open the repository in VS Code
2. Press `F5` to launch Extension Development Host
3. In the new window, open a workspace
4. Press `Ctrl+Shift+P` → `ForgeAI: Start Task`
5. Enter a coding task

## Running Tests

```powershell
# Run all tests
pnpm test

# Run specific package tests
pnpm --filter @forgeai/core test
pnpm --filter @forgeai/agent test
```

## Running Builds

```powershell
# Build all packages
pnpm build

# Build specific package
pnpm --filter @forgeai/core run build
pnpm --filter @forgeai/agent run build
pnpm --filter @forgeai/server run build
```

## Type Checking

```powershell
pnpm typecheck
```

## Security Model

- **API keys**: Never leave the server. VS Code extension sends only provider type and model name.
- **Path traversal**: All file tools validate paths against workspace root using `path.resolve()`.
- **Sensitive files**: `.env`, `*.key`, `*.pem`, `credentials.json`, `id_rsa`, etc. are excluded from context and blocked from reading.
- **Command safety**: Destructive commands (`rm -rf`, `del /f`, `rmdir`, `rd /s`, `format`, `mkfs`, `shutdown`, `restart`, `diskpart`, fork bombs) are blocked by pattern matching. Note: this is reasonable V0.3.1 safety, not enterprise sandboxing.
- **Workspace boundary**: Tools cannot access files outside the opened workspace.

## Troubleshooting

### "Missing API key for provider gemini"
Set the `GEMINI_API_KEY` environment variable before starting the server.

### "Another task is already running"
Only one task can run at a time. Cancel the current task via `ForgeAI: Cancel Task` command, or restart the server.

### "tree-sitter install failed"
Tree-sitter native parsers require Visual Studio C++ build tools on Windows. ForgeAI falls back to regex-based symbol extraction automatically. This is expected behavior on Windows without VS build tools.

### Port 4141 already in use
Stop the existing ForgeAI server process, or change the port in `apps/server/src/index.ts`.

### Extension not activating
Check the Extension Development Host console (`Help → Toggle Developer Tools`) for errors. Ensure the server is running.

## Roadmap

- **Phase 3**: Tool reliability, streaming UX improvements, token counting
- **Phase 4**: Multi-agent architecture
- **Phase 5**: Conversation persistence, vector search
