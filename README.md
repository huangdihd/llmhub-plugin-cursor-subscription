# Cursor Subscription — external LLMHub provider

Experimental, independently packaged LLMHub provider using the official Cursor Agent CLI through `cursor-api-proxy@1.7.0`. This directory is a standalone project, **not** part of LLMHub's built-in providers or official `plugins/` tree.

**Status:** offline protocol/lifecycle tests pass. An authorized live text smoke test through the registered adapter and existing CLI login succeeded with `composer-2.5`, returning the requested `OK` in about 18.7 seconds. An earlier Haiku request returned a payment-method prompt; that third-party-model result does **not** mean the shared subscription pool is unavailable. Real per-account API-key inference, streaming and ACP tool execution remain unverified. Installing this package does not install Cursor CLI, authenticate an account, or guarantee that a plan includes API/Agent usage. Requests consume the signed-in Cursor account's applicable quota and may incur charges under its settings. Check Cursor's current terms and plan restrictions.

## Requirements

- macOS or Linux with Node.js 18.2 or later (tested on macOS with Node 24). Windows is not supported by this release's process-group supervisor.
- LLMHub **plugin API** `^1.5.0` (not the application's version number).
- Official `cursor-agent`/`agent` executable on the **LLMHub server**, with ACP support. Containers need the CLI and authentication in the container, not just on the host.
- Configure a **separate Cursor user API key for each provider** (Cursor Dashboard → API Keys), or explicitly select the server's existing CLI login for one provider. The plugin never extracts IDE tokens or changes account identifiers. See [official CLI authentication](https://cursor.com/docs/cli/reference/authentication).

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
ARCHIVE=/absolute/path/to/llmhub-plugin-cursor-subscription-0.3.0.tgz
mkdir "$PLUGIN_DIRECTORY"  # existing directory: stop, do not overwrite it
tar -xzf "$ARCHIVE" -C "$PLUGIN_DIRECTORY" --strip-components=1
(cd "$PLUGIN_DIRECTORY" && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
```

Use **Plugins → Scan**, configure the plugin, then enable it. Add a provider of type **Cursor Subscription** (`cursor-subscription:cursor`) and refresh its model catalog. Give the provider a distinct name; model IDs become `<provider-name>/<cursor-model-id>`. Explicitly select an unqualified catalog model ID rather than `default`; slash-containing IDs are rejected because the pinned proxy would otherwise silently truncate them.

For reproducible local deployment, copying the source package **with `package-lock.json`** and running `npm ci --omit=dev --ignore-scripts` is preferable. The npm archive does not bundle `node_modules` or the lockfile.

### GitHub and npm installation

Use LLMHub's existing **Install GitHub** workflow with:

`https://github.com/huangdihd/llmhub-plugin-cursor-subscription`

The `v0.3.0` GitHub Release includes the `.tgz` archive for local installation. For **Install npm**, the package specification is `llmhub-plugin-cursor-subscription@0.3.0`. Check registry availability with `npm view llmhub-plugin-cursor-subscription@0.3.0 version` before using npm installation; GitHub and npm publication are independent.

Both installation paths still require plugin configuration and enablement. Installing does not authenticate Cursor or create a provider automatically.

## Configuration: one account per provider

**Changed in 0.2.0:** credentials and account settings are now per-provider. Version `0.1.0` used plugin-global credentials. Upgrading requires the migration below; existing credentials are never silently copied across provider records.

The only active plugin-global setting is `agent_binary` (empty: discover CLI on PATH). It may be an executable path, not a shell command. Version **0.2.1** also retains the four deprecated global fields in its schema so LLMHub can validate saved 0.1.0 configurations during an update. They are labelled unused, the old key remains secret-masked, and **none of them is used for requests or copied into providers**. Nondefault legacy settings produce a migration warning without blocking plugin activation.

Configure these fields on **each Cursor Subscription provider**, stored in `connection.extra`:

| Key | Default | Meaning |
|---|---|---|
| `auth_mode` | `api_key` | This provider's Cursor user API key, or explicitly `cli_login` for the server login. |
| `cursor_api_key` | empty | Secret belonging to this account. Required in `api_key` mode; empty **never** falls back to local login. Must be empty in `cli_login` mode. |
| `cursor_session_token` | empty | Optional secret: same account’s `WorkosCursorSessionToken` cookie **value only**, for the dashboard quota route. Not needed for CLI `/usage` or API-key shared-pool queries. |
| `timeout_seconds` | `180` | Whole request deadline, including startup and response body; range 1–3600. Also supplies upstream CLI/session timeout. |
| `enable_tools` | `false` | Opt in to experimental ACP tools after verifying CLI compatibility. |

Each provider owns its credentials, lazy worker, automatic private port, catalog and tool sessions. Identical settings reuse that provider's worker; different providers never share workers. Changing an account's credentials/settings cancels only its worker and invalidates its old adapters and tool sessions. The replacement waits for shutdown before starting. Changing the global CLI executable stops all workers. Do not reconfigure during a tool conversation.

`cli_login` is a limited, explicit single-account convenience, **not** a multi-account login/profile manager or an OAuth connection flow. The current plugin instance reserves it to one provider name. Changing the server's CLI login changes that provider's identity; never use this mode as an isolated multi-account credential store. LLMHub's public plugin API has no provider-removal callback: after deleting/renaming a provider, disable/re-enable the plugin to stop its unused worker and release any CLI-login reservation. This restriction is not coordinated across gateway instances or plugin restarts. Use per-account keys for multiple accounts.

### Migration from 0.1.0

1. Stop ongoing conversations and update directly to **0.2.1 or later**. Version 0.2.0 removed legacy schema fields and could fail with `Unknown configuration field` even when only defaults were saved; 0.2.1 fixes that upgrade path. Do not uninstall or clear storage as a workaround.
2. Configure the intended provider with its own key and tools/timeout settings. Do not copy one key into unrelated account records. Alternatively explicitly select `cli_login` for one provider using the server login.
3. Old global values can stay stored: they are inactive and do not block updating. The plugin never prints or retrieves the old secret through its API. Re-enter the account's key yourself if needed. Ports are automatic.
4. Enable the plugin if it was disabled, and reload providers/model catalogs. Unmigrated provider records fail explicitly instead of using the old global key. Start new tool conversations; old pending sessions cannot be resumed.

Inherited Cursor key/token environment variables are never used. Per-account key mode supplies an empty temporary home before loading upstream code, preventing its normal login-file discovery and macOS Keychain symlink fallback. This is configuration isolation, **not** an OS security boundary.

## Subscription quota queries (0.3.0)

The registered provider implements LLMHub's `subscriptionUsage` callback. Authentication is **per provider**; it never estimates remaining subscription quota from character counts or missing counters. Queries do not send model prompts, retry inference, or change payment settings.

- **`api_key`, no session cookie:** exchanges this provider's user API key at `https://api2.cursor.sh/auth/exchange_user_api_key`, then queries bearer-authenticated `aiserver.v1.DashboardService/GetSandUsageStatus`. A confirmed unified pool yields **X shared weekly quota**, reported used percentage and exact next reset. Access/refresh tokens are not persisted or logged. Non-unified/denied results fail explicitly, rather than using another account. Live server authorization for this path remains unverified.
- **`cli_login`, no session cookie:** uses the official interactive **`/usage`** command in an empty worker workspace, through a system **`python3` standard-library PTY helper** (macOS/Linux). It verifies the registered Usage menu entry before submitting; missing commands fail without falling through to model inference. **Never use `agent -p /usage`, `agent usage`, or ACP `/usage` as a substitute:** in the verified CLI build those can become model prompts. This reports **CLI included plan**, rounded as displayed by Cursor. The current CLI queries `GetCurrentPeriodUsage`, not the unified-pool RPC, so this meter is **not claimed to be X shared weekly quota**. Its reset month/day is displayed as detail; no year, time or exact reset timestamp is invented. CLI UI changes, missing python3, unavailable login and unsupported enterprise panels fail explicitly.
- **Explicit `cursor_session_token`:** queries Cursor's dashboard endpoints with that cookie, after comparing dashboard identity to this provider's official CLI `status --format json` identity. Mismatched accounts are rejected before usage queries. This supports confirmed X shared weekly quota and measurable legacy individual-plan quota. No browser storage, Keychain or CLI credential files are read by the plugin.

To opt into dashboard queries, sign in to **the same account** at `https://cursor.com`, open browser developer tools → Application/Storage → Cookies → `cursor.com`, and copy only the value of **`WorkosCursorSessionToken`** into this provider's secret field. This is a login credential: **do not paste it into chat, logs or issue reports**. Do not copy a whole Cookie header. On session expiration, replace that provider's field. It is secret-masked by LLMHub and never passed to the inference worker.

Dashboard traffic is restricted to `https://cursor.com/api/auth/me`, `/api/usage-summary`, and `/api/dashboard/get-sand-usage-status`; API-key traffic is restricted to the two `api2.cursor.sh` endpoints above. Redirects are rejected. A whole-query deadline, bounded JSON bodies and generic errors prevent hanging requests or error-body credential disclosure. Missing/invalid quota data is an error, **not 0% used**. Trial expiry is not a recurring reset; extra spending caps, third-party model balances, teams and banked resets are not misrepresented as the shared pool.

These are **internal first-party endpoints/UI, not a documented stable public quota API**. Protocol mapping was checked against the official CLI `2026.10.22-27dcf5f` and [CodexBar's Cursor implementation](https://github.com/steipete/CodexBar/tree/0538e94b464db0c12776e4bf6e7b11c66e44d275/Sources/CodexBarCore/Providers/Cursor). The installed CLI's interactive `/usage` was read successfully without inference; the registered plugin callback then returned Premium, 23% used and `Resets Nov 2` in 4.2 seconds through the real worker/PTY path. API-key exchange and explicit dashboard-cookie quota retrieval are covered by offline fixtures but have not been live-account verified.

**Host cache limitation:** LLMHub caches usage for 60 seconds by provider name. After changing account credentials, use a forced usage refresh or wait for cache expiry; a normal cache hit may briefly show the previous account's snapshot without invoking the plugin. Plugin-level in-flight generation checks reject stale responses, but cannot invalidate a host cache hit. Changing the quota session also restarts only that provider's worker and invalidates old adapters.

## Capabilities and explicit limits

- Text conversations, streaming, model discovery, and visible reasoning where the upstream path returns it (ordinary ACP chat paths may return text only).
- Function tools and tool-result continuation through ACP, opt-in. Tool continuations must end with their tool results; submit new user text after the assistant completes. Tool results must refer to the current parked calls; expired/replayed calls fail instead of launching a new tool execution. No automatic inference retry.
- Text system prompt and supported reasoning-effort selection. Role/history structure reaches the proxy intact, but **the upstream proxy sanitizes text and renders history as a prompt; this plugin adds explicit historical tool-call/result labels because upstream otherwise drops call names/arguments**; this is not native system/developer-role isolation or byte-exact prompt delivery.
- Images, embeddings, opaque/replayed thinking, structured JSON output, sampling controls (`temperature`, `topP`), `maxTokens`, stop sequences, logprobs and thinking budgets/summaries are explicitly rejected. Remove these client options rather than assuming the CLI obeys them.
- Tool error flags are not silently converted to successful results. This version rejects unrepresentable `isError: true` blocks.
- Provider-facing requests are limited to 8 MiB. No caller-controlled mode/workspace or built-in shell execution is exposed by the plugin interface.
- **Token usage is unknown.** The pinned proxy estimates tokens from characters. The plugin discards that heuristic and returns zero as the current LLMHub contract's unknown placeholder, **not zero consumption**. Do not use these values for billing, token quotas or cost accounting. Subscription quota is queried separately; it is not inferred from these token placeholders (see above).
- No ordinary cross-turn Agent cache. A tool exchange can continue its active ACP session, but complete user turns are not globally reused. Always send full conversation history.

### Cancellation and ownership

Cancelling the adapter's returned stream aborts its HTTP request. Upstream ties response disconnection to CLI/ACP cancellation. Timeouts and plugin shutdown also abort requests. **LLMHub's public adapter API does not supply a request AbortSignal**, so an ingress disconnect only cancels upstream if the host actually cancels the returned stream; non-streaming requests rely on the deadline/shutdown. Already executed external tool side effects cannot be rolled back.

Each provider has a separate worker, with its own random secret and HMAC-derived bearer token. Model identity is also included in the upstream session owner, isolating tool sessions across provider records and models. A provider is **not a separate identity for every LLMHub API-key user**: the current request contract lacks that identity. Tool-call IDs are unguessable upstream capabilities, not a replacement for tenant authorization. For mutually untrusted tenants, use separate gateway/account deployments. Pending tool sessions expire under upstream TTL and are lost on restart; exactly-once execution across retries/restarts is not promised.

### Security boundary

- Child process with a restricted environment; gateway API/database secrets, `NODE_OPTIONS`, arbitrary Cursor endpoints, account pools and upstream overrides are not inherited.
- Loopback-only HTTP, random per-worker secret, authenticated allowlisted model/chat and read-only identity/usage routes, startup acknowledgement over IPC. The upstream web dashboard and other administrative routes are **not mounted**.
- The CLI is launched against temporary workspaces, not the LLMHub repository. Upstream ACP rejects ordinary permission requests and permits its own external-tool bridge. `force`, automatic MCP approval, raw debug and verbose request logging are disabled. Child stdout/stderr are not forwarded or saved by the plugin; upstream's persistent session/error log is explicitly redirected to the null device. Account-directory autodiscovery is disabled.
- This is **not an OS sandbox**. The child still runs as the gateway's OS user; explicit `cli_login` authentication can use that user's CLI login and on macOS links Keychain resources into temporary homes. In `api_key` mode the plugin does not expose that home or create those links; the CLI remains a trusted same-user process, not a sandboxed adversary. Authentication and CLI dependencies remain trusted. Run the gateway/CLI in a separate container or OS account if filesystem containment is required.
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

`npm test` is offline: codec boundaries, mixed tool histories, unsupported options, incremental SSE, cancellation, deadlines, startup races, environment filtering and real worker authentication/port conflicts. Tests use local fixtures, not Cursor inference or account credentials. They also cover separate provider keys/workers/catalogs, rotation and shutdown races, stale discovery, explicit CLI ownership, and empty homes without Keychain links in key mode.

On `HTTP 4xx/5xx`, first verify CLI login, exact model ID, supported client options and ACP compatibility on the server. Detailed arbitrary HTTP/SSE error bodies are deliberately not echoed into gateway errors. Private ports are OS-assigned; startup failures should not be worked around by attaching to an existing service. Tool-session errors after reconfiguration/restart require a new conversation, not blind replay of tool results.

### Host upgrade regression tests

`integration/host-upgrade.test.mjs` exercises the real LLMHub `PluginManager.update` transaction with a local fake npm installer and in-memory storage: 0.1.0 defaults, 0.1.0 nondefault settings plus a fake secret, and 0.2.0. It confirms the old failure, successful activation after replacement, preservation/masking of stored values, no implicit credential migration, quota callback/secret registration, and a fixture shared-quota query through the host registry. It never reads real host configuration or starts the CLI.

After compiling the host runtime as in LLMHub's `tests/run-all.sh`, run:

```sh
NODE_PATH=/absolute/path/to/LLMHub/node_modules \
  LLMHUB_BUILD=/absolute/path/to/compiled-host/server \
  node --test integration/host-upgrade.test.mjs
```

Before production, run an explicitly authorized small live text/stream request and a tool round-trip/cancel test against the intended CLI version/account, then measure latency under a representative workload. No such paid/live test is included in the offline test suite.

Local manual smoke results through the registered adapter using explicit `cli_login`: prompt `Reply only OK`, tools disabled, 30-second deadline, one non-streaming request per model:

- `composer-2.5`: returned exactly `OK`, finish reason `stop`, in 18.7 seconds. This verifies a minimal live text inference path, not streaming, tools or per-account API-key authentication.
- Earlier `claude-haiku-5-5-low`: returned `Add a payment method to continue` after about 18 seconds, wrapped as text with finish reason `stop`. This did not pass the smoke test and does not establish that shared subscription usage is unavailable.

[Cursor's current pricing documentation](https://cursor.com/docs/models-and-pricing) says The X Subscription's included pool covers Grok 4.7/4.6/4.5 and Composer 2.5, including CLI usage. Third-party Claude, GPT and Gemini models are outside that pool and have separate payment requirements. Legacy Cursor plans have different rules; check the applicable plan instead of choosing a test model solely by its list price.

The plugin does not reinterpret arbitrary assistant text as a billing error. There were no automatic retries/fallbacks or payment-setting changes. Actual token consumption, pool deductions and charges were not measured.

## License

MIT. `cursor-api-proxy@1.7.0` is an MIT-licensed dependency with its own license. Cursor and LLMHub are independent projects; this package is not an official Cursor integration.
