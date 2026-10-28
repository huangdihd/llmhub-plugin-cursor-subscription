# Cursor Subscription — external LLMHub provider

Experimental, independently packaged LLMHub provider using the official Cursor Agent CLI through `cursor-api-proxy@1.7.0`. This directory is a standalone project, **not** part of LLMHub's built-in providers or official `plugins/` tree.

**Status:** offline protocol/lifecycle tests pass; real subscription inference, CLI authentication and ACP tool execution have not been end-to-end verified. Installing this package does not install Cursor CLI, authenticate an account, or guarantee that a plan includes API/Agent usage. Requests consume the signed-in Cursor account's applicable quota and may incur charges under its settings. Check Cursor's current terms and plan restrictions.

## Requirements

- macOS or Linux with Node.js 18.2 or later (tested on macOS with Node 24). Windows is not supported by this release's process-group supervisor.
- LLMHub **plugin API** `^1.5.0` (not the application's version number).
- Official `cursor-agent`/`agent` executable on the **LLMHub server**, with ACP support. Containers need the CLI and authentication in the container, not just on the host.
- Authenticate the CLI yourself, or configure an appropriate Cursor API key through the plugin's secret field. The plugin never extracts IDE tokens or changes account identifiers.

## Installation

This repository is directly distributable JavaScript; no build step is required.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm pack
```

### Local package / directory Scan

LLMHub does **not** currently offer a `.tgz` upload endpoint. To install a locally built archive, create a **new, empty** directory named `cursor-subscription` in the running gateway's plugin directory (default `<LLMHub working directory>/.data/plugins`). Extract there and install runtime dependencies:

```sh
# Set these to the actual paths on the gateway machine.
PLUGIN_DIRECTORY=/absolute/path/to/LLMHub/.data/plugins/cursor-subscription
ARCHIVE=/absolute/path/to/llmhub-plugin-cursor-subscription-0.1.0.tgz
mkdir "$PLUGIN_DIRECTORY"  # existing directory: stop, do not overwrite it
tar -xzf "$ARCHIVE" -C "$PLUGIN_DIRECTORY" --strip-components=1
(cd "$PLUGIN_DIRECTORY" && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
```

Use **Plugins → Scan**, configure the plugin, then enable it. Add a provider of type **Cursor Subscription** (`cursor-subscription:cursor`) and refresh its model catalog. Give the provider a distinct name; model IDs become `<provider-name>/<cursor-model-id>`. Explicitly select an unqualified catalog model ID rather than `default`; slash-containing IDs are rejected because the pinned proxy would otherwise silently truncate them.

For reproducible local deployment, copying the source package **with `package-lock.json`** and running `npm ci --omit=dev --ignore-scripts` is preferable. The npm archive does not bundle `node_modules` or the lockfile.

### GitHub and npm installation

Use LLMHub's existing **Install GitHub** workflow with:

`https://github.com/huangdihd/llmhub-plugin-cursor-subscription`

The `v0.1.0` GitHub Release includes the `.tgz` archive for local installation. For **Install npm**, the package specification is `llmhub-plugin-cursor-subscription@0.1.0`. Check registry availability with `npm view llmhub-plugin-cursor-subscription@0.1.0 version` before using npm installation; GitHub and npm publication are independent.

Both installation paths still require plugin configuration and enablement. Installing does not authenticate Cursor or create a provider automatically.

## Plugin configuration

| Key | Default | Meaning |
|---|---|---|
| `agent_binary` | empty | Discover CLI on PATH, or use an absolute executable path. Not a shell command. |
| `cursor_api_key` | empty | Secret key; empty uses the existing CLI login. Inherited Cursor API-key environment variables are deliberately not used. |
| `bridge_port` | `0` | OS-assigned private port. A fixed port must be free; existing services are never adopted or killed. |
| `timeout_seconds` | `180` | Whole request deadline, including startup and response body; allowed range 1–3600. Also supplies upstream CLI/session timeout. |
| `enable_tools` | `false` | Opt in to experimental ACP tool calls after verifying your CLI supports HTTP MCP. |

Credentials are plugin-global: all provider records use **one Cursor account**. This is not a multi-account pool. Configuration changes stop the old worker, cancel active requests and invalidate parked tool sessions. The replacement starts lazily after the old worker exits. Do not change configuration in the middle of a tool conversation.

## Capabilities and explicit limits

- Text conversations, streaming, model discovery, and visible reasoning where the upstream path returns it (ordinary ACP chat paths may return text only).
- Function tools and tool-result continuation through ACP, opt-in. Tool continuations must end with their tool results; submit new user text after the assistant completes. Tool results must refer to the current parked calls; expired/replayed calls fail instead of launching a new tool execution. No automatic inference retry.
- Text system prompt and supported reasoning-effort selection. Role/history structure reaches the proxy intact, but **the upstream proxy sanitizes text and renders history as a prompt; this plugin adds explicit historical tool-call/result labels because upstream otherwise drops call names/arguments**; this is not native system/developer-role isolation or byte-exact prompt delivery.
- Images, embeddings, opaque/replayed thinking, structured JSON output, sampling controls (`temperature`, `topP`), `maxTokens`, stop sequences, logprobs and thinking budgets/summaries are explicitly rejected. Remove these client options rather than assuming the CLI obeys them.
- Tool error flags are not silently converted to successful results. This version rejects unrepresentable `isError: true` blocks.
- Provider-facing requests are limited to 8 MiB. No caller-controlled mode/workspace or built-in shell execution is exposed by the plugin interface.
- **Token usage is unknown.** The pinned proxy estimates tokens from characters. The plugin discards that heuristic and returns zero as the current LLMHub contract's unknown placeholder, **not zero consumption**. Do not use these values for billing, token quotas or cost accounting. Subscription balance/usage reporting is not implemented.
- No ordinary cross-turn Agent cache. A tool exchange can continue its active ACP session, but complete user turns are not globally reused. Always send full conversation history.

### Cancellation and ownership

Cancelling the adapter's returned stream aborts its HTTP request. Upstream ties response disconnection to CLI/ACP cancellation. Timeouts and plugin shutdown also abort requests. **LLMHub's public adapter API does not supply a request AbortSignal**, so an ingress disconnect only cancels upstream if the host actually cancels the returned stream; non-streaming requests rely on the deadline/shutdown. Already executed external tool side effects cannot be rolled back.

The worker gives each provider name a different HMAC-derived bearer token and includes model identity in the upstream session owner, isolating tool sessions across provider records and models. A provider is **not a separate identity for every LLMHub API-key user**: the current request contract lacks that identity. Tool-call IDs are unguessable upstream capabilities, not a replacement for tenant authorization. For mutually untrusted tenants, use separate gateway/account deployments. Pending tool sessions expire under upstream TTL and are lost on restart; exactly-once execution across retries/restarts is not promised.

### Security boundary

- Child process with a restricted environment; gateway API/database secrets, `NODE_OPTIONS`, arbitrary Cursor endpoints, account pools and upstream overrides are not inherited.
- Loopback-only HTTP, random per-worker secret, authenticated allowlisted model/chat routes, startup acknowledgement over IPC. The upstream web dashboard and other administrative routes are **not mounted**.
- The CLI is launched against temporary workspaces, not the LLMHub repository. Upstream ACP rejects ordinary permission requests and permits its own external-tool bridge. `force`, automatic MCP approval, raw debug and verbose request logging are disabled. Child stdout/stderr are not forwarded or saved by the plugin; upstream's persistent session/error log is explicitly redirected to the null device. Account-directory autodiscovery is disabled.
- This is **not an OS sandbox**. The child still runs as the gateway's OS user; upstream authentication can use that user's CLI login and on macOS links Keychain resources into temporary homes. Authentication and CLI dependencies remain trusted. Run the gateway/CLI in a separate container or OS account if filesystem containment is required.
- The worker supervises its own detached child groups, escalating TERM to KILL within a bounded grace period, independently of upstream's closed flags. All request temp roots live under the worker root. Shutdown initiates bounded asynchronous cleanup to respect LLMHub's short plugin cleanup deadline. A crash/SIGKILL can leave temporary directories or orphaned CLI processes; no guarantee of remote cancellation is made after an abrupt OS/process failure.

## Architecture and optimization notes

```text
LLMHub portable ProviderAdapter
    → private loopback HTTP + incremental SSE normalization
    → plugin-owned worker (IPC lifecycle, isolated upstream module state)
    → pinned cursor-api-proxy protocol implementation
    → official Cursor CLI / ACP
```

The dependency's public SDK is an HTTP client, not an in-process inference engine. This package intentionally retains one local HTTP hop. The disposable worker also installs a narrow spawn/signal supervisor before loading upstream modules; it never patches the gateway process. Only the worker imports pinned upstream internals; it never imports LLMHub internal files. Those upstream imports are private API and must be re-reviewed on dependency upgrades.

Implemented without speculative speed claims:

- Lazy, single-flight worker startup: plugin setup never waits for CLI startup or model discovery.
- OS-assigned ports: no probe/reserve/rebind race or accidental reuse of unrelated services.
- Streaming forwards complete SSE events incrementally, preserving UTF-8 across byte boundaries; no whole-answer buffering. Malformed/truncated streams fail, and already-exposed output is never transparently retried.
- Reuses upstream's existing model-catalog TTL/single-flight and active ACP tool sessions instead of adding redundant caches.

Reviewed [`iFwu/cursor2response` at `898ffd41`](https://github.com/iFwu/cursor2response/tree/898ffd41b78b2c1a85b5b1c9475517af6fa5834b) for ownership, cancellation and session-reuse ideas. It uses a different SDK backend, exact transcript-prefix checkpoints and long-lived Agents. That is a separate architectural option, **not a drop-in optimization** for CLI login/quotas. This plugin does not copy its implementation, reuse chats by approximate prefix, or claim measured latency/cache/price improvements.

## Verification and troubleshooting

`npm test` is offline: codec boundaries, mixed tool histories, unsupported options, incremental SSE, cancellation, deadlines, startup races, environment filtering and real worker authentication/port conflicts. Tests use local fixtures, not Cursor inference or account credentials.

On `HTTP 4xx/5xx`, first verify CLI login, exact model ID, supported client options and ACP compatibility on the server. Detailed arbitrary HTTP/SSE error bodies are deliberately not echoed into gateway errors. For a startup port error, use port `0` or another free port. Tool-session errors after reconfiguration/restart require a new conversation, not blind replay of tool results.

Before production, run an explicitly authorized small live text/stream request and a tool round-trip/cancel test against the intended CLI version/account, then measure latency under a representative workload. No such paid/live test is included in the offline test suite.

## License

MIT. `cursor-api-proxy@1.7.0` is an MIT-licensed dependency with its own license. Cursor and LLMHub are independent projects; this package is not an official Cursor integration.
