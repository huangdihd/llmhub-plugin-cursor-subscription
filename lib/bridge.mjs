import { fork } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'

const workerURL = new URL('./worker.mjs', import.meta.url)
const encoder = new TextEncoder()

export function parseConfiguration(configuration = {}) {
  const port = configuration.bridge_port ?? 0
  const timeoutSeconds = configuration.timeout_seconds ?? 180
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('bridge_port must be an integer between 0 and 65535')
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error('timeout_seconds must be between 1 and 3600')
  }
  if (configuration.enable_tools !== undefined && typeof configuration.enable_tools !== 'boolean') {
    throw new Error('enable_tools must be a boolean')
  }
  for (const key of ['agent_binary', 'cursor_api_key']) {
    if (configuration[key] !== undefined && typeof configuration[key] !== 'string') {
      throw new Error(`${key} must be a string`)
    }
  }
  const authMode = configuration.auth_mode ?? 'api_key'
  const apiKey = configuration.cursor_api_key || ''
  if (!['api_key', 'cli_login'].includes(authMode)) throw new Error('auth_mode must be api_key or cli_login')
  if (authMode === 'api_key' && !apiKey.trim()) {
    throw new Error('This provider requires its own cursor_api_key; select cli_login explicitly to use the server login')
  }
  if (authMode === 'cli_login' && apiKey) {
    throw new Error('cli_login cannot be combined with cursor_api_key; choose one account authentication method')
  }
  return {
    port, timeoutMilliseconds: timeoutSeconds * 1000, authMode,
    agentBinary: configuration.agent_binary?.trim() || '',
    apiKey,
  }
}

export function workerEnvironment(configuration, secret, source = process.env) {
  // Allowlist instead of copying the gateway's environment (API/database keys,
  // NODE_OPTIONS and upstream workspace/account-pool overrides must not leak).
  const environment = {}
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (source[key] !== undefined) environment[key] = source[key]
  }
  Object.assign(environment, {
    LLMHUB_CURSOR_AUTH_MODE: configuration.authMode,
    CURSOR_BRIDGE_HOST: '127.0.0.1', CURSOR_BRIDGE_PORT: String(configuration.port),
    CURSOR_BRIDGE_API_KEY: secret, CURSOR_BRIDGE_USE_ACP: 'true',
    CURSOR_BRIDGE_MODE: 'ask', CURSOR_BRIDGE_FORCE: 'false', CURSOR_BRIDGE_APPROVE_MCPS: 'false',
    CURSOR_BRIDGE_STRICT_MODEL: 'true', CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE: 'true',
    CURSOR_BRIDGE_VERBOSE: 'false', CURSOR_BRIDGE_MAX_MODE: 'false',
    CURSOR_BRIDGE_PROMPT_VIA_STDIN: 'true', CURSOR_BRIDGE_ACP_RAW_DEBUG: 'false',
    CURSOR_BRIDGE_TIMEOUT_MS: String(configuration.timeoutMilliseconds),
  })
  if (configuration.authMode === 'api_key') {
    delete environment.HOME
    delete environment.USERPROFILE
  }
  if (configuration.agentBinary) environment.CURSOR_AGENT_BIN = configuration.agentBinary
  if (configuration.apiKey) environment.CURSOR_API_KEY = configuration.apiKey
  return environment
}

function waitWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Incremental SSE framing, with cancellation propagated to the HTTP request. */
export function normalizeSSE(body, finish = () => {}, abort = () => {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let data = []
  let dataLength = 0
  let ended = false
  let released = false
  let cancelled = false
  let emitted = 0
  const release = () => {
    if (released) return
    released = true
    finish()
    reader.releaseLock()
  }
  function line(value, controller) {
    if (value.endsWith('\r')) value = value.slice(0, -1)
    if (value !== '') {
      if (value.startsWith('data:')) {
        const field = value.slice(5).replace(/^ /, '')
        dataLength += field.length + 1
        if (dataLength > 8 * 1024 * 1024) throw new Error('Cursor stream event exceeds 8 MiB')
        data.push(field)
      }
      return
    }
    if (!data.length) return
    const payload = data.join('\n')
    data = []
    dataLength = 0
    if (payload === '[DONE]') {
      ended = true
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      return
    }
    // Re-serialize multiline SSE JSON into the single line required by LLMHub.
    const event = JSON.parse(payload)
    if (event?.error) {
      throw new Error('Cursor stream failed; verify CLI authentication, model and ACP compatibility')
    }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    emitted++
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        const previousEmitted = emitted
        while (!cancelled) {
          const { value, done } = await reader.read()
          if (cancelled) return
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
          let newline
          while (!ended && (newline = buffer.indexOf('\n')) !== -1) {
            line(buffer.slice(0, newline), controller)
            buffer = buffer.slice(newline + 1)
          }
          if (buffer.length + dataLength > 8 * 1024 * 1024) {
            throw new Error('Cursor stream event exceeds 8 MiB')
          }
          if (done && !ended) {
            if (buffer) line(buffer, controller)
            line('', controller)
            if (!ended) throw new Error('Cursor stream ended before [DONE]')
          }
          if (ended) {
            await reader.cancel()
            release()
            controller.close()
            return
          }
          if (emitted !== previousEmitted) return
        }
      } catch (error) {
        if (cancelled) return
        try { await reader.cancel(error) } finally {
          abort(error)
          release()
          controller.error(error)
        }
      }
    },
    async cancel(reason) {
      cancelled = true
      try { await reader.cancel(reason) } finally {
        abort(reason)
        release()
      }
    },
  })
}

export class CursorBridge {
  #configuration
  #worker
  #startup
  #closed = false
  #closing
  #secret = randomBytes(32).toString('hex')
  #requests = new Set()
  #launch
  #startupMilliseconds

  constructor(configuration, { launch = fork, startupMilliseconds = 10_000 } = {}) {
    this.#configuration = parseConfiguration(configuration)
    this.#launch = launch
    this.#startupMilliseconds = startupMilliseconds
  }

  ensureReady() {
    if (this.#closed) return Promise.reject(new Error('Cursor bridge is closed'))
    if (this.#startup) return this.#startup
    this.#startup = new Promise((resolve, reject) => {
      const child = this.#launch(workerURL, [], {
        env: workerEnvironment(this.#configuration, this.#secret),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
      })
      this.#worker = child
      let ready = false
      const deadline = setTimeout(() => {
        reject(new Error('Cursor bridge startup timed out'))
        void this.close()
      }, this.#startupMilliseconds)
      child.on('message', (message) => {
        if (message?.type === 'failed') {
          reject(new Error(`Cursor bridge failed to start (${message.code})`))
          void this.close()
          return
        }
        if (message?.type !== 'ready' || ready || this.#closed) return
        if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) {
          reject(new Error('Cursor bridge sent an invalid port'))
          void this.close()
          return
        }
        ready = true
        clearTimeout(deadline)
        resolve(`http://127.0.0.1:${message.port}`)
      })
      child.once('error', (error) => {
        clearTimeout(deadline)
        reject(error)
        void this.close()
      })
      child.once('exit', () => {
        clearTimeout(deadline)
        this.#worker = undefined
        this.#startup = undefined
        const error = new Error('Cursor bridge process exited')
        reject(error)
        for (const controller of this.#requests) controller.abort(error)
      })
    })
    return this.#startup
  }

  async #request(path, scope, payload, signal) {
    if (!scope || scope.length > 256) throw new Error('A provider name of 1–256 characters is required')
    const controller = new AbortController()
    this.#requests.add(controller)
    const cancel = () => controller.abort(new Error('Cursor request cancelled'))
    if (signal?.aborted) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
    const deadline = setTimeout(() => controller.abort(new Error('Cursor request deadline exceeded')),
      this.#configuration.timeoutMilliseconds)
    const finish = () => {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', cancel)
      this.#requests.delete(controller)
    }
    try {
      if (controller.signal.aborted) throw controller.signal.reason
      const baseURL = await waitWithSignal(this.ensureReady(), controller.signal)
      const token = createHmac('sha256', this.#secret).update(scope).digest('hex')
      const response = await fetch(`${baseURL}${path}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-llmhub-provider': scope,
          'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal, redirect: 'error',
      })
      if (!response.ok) {
        // Never forward an arbitrary upstream error body, which may contain prompts.
        await response.body?.cancel()
        throw new Error(`Cursor bridge HTTP ${response.status}; check CLI login, model and ACP support`)
      }
      return { response, finish, abort: (reason) => controller.abort(reason) }
    } catch (error) {
      finish()
      throw error
    }
  }

  async requestJSON(path, scope, payload, signal) {
    const { response, finish, abort } = await this.#request(path, scope, payload, signal)
    try {
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Cursor bridge returned a non-JSON response')
      }
      return await response.json()
    } catch (error) {
      abort(error)
      throw error
    } finally {
      finish()
    }
  }

  async requestStream(scope, payload) {
    const { response, finish, abort } = await this.#request('/v1/chat/completions', scope,
      { ...payload, stream: true })
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      abort(new Error('Cursor bridge did not return an SSE stream'))
      finish()
      throw new Error('Cursor bridge did not return an SSE stream')
    }
    return normalizeSSE(response.body, finish, abort)
  }

  close() {
    if (this.#closing) return this.#closing
    this.#closed = true
    for (const controller of this.#requests) controller.abort(new Error('Cursor bridge is shutting down'))
    const child = this.#worker
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    this.#closing = new Promise((resolve) => {
      const deadline = setTimeout(() => child.kill('SIGKILL'), 4_500)
      child.once('exit', () => { clearTimeout(deadline); resolve() })
      if (child.connected) child.send({ type: 'stop' }, (error) => { if (error) child.kill('SIGTERM') })
      else child.kill('SIGTERM')
    })
    return this.#closing
  }
}
