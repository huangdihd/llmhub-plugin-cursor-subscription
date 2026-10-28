import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir, devNull } from 'node:os'
import { installSupervision } from './supervision.mjs'
import { preserveToolHistory } from './history.mjs'
import { readAccountIdentity } from './identity.mjs'
import { readCLIUsage } from './cli-usage.mjs'
import { pathToFileURL } from 'node:url'

// Private upstream imports stay in this disposable process, never in LLMHub.
// Pin the dependency: these modules are not a public upstream SDK contract.
const supervision = installSupervision()
const require = createRequire(import.meta.url)
const upstreamRoot = dirname(require.resolve('cursor-api-proxy/package.json'))
const upstream = (name) => import(pathToFileURL(join(upstreamRoot, 'dist/lib', `${name}.js`)).href)

if (!process.send || !process.env.CURSOR_BRIDGE_API_KEY) {
  throw new Error('This worker must be started by the LLMHub Cursor plugin')
}

const authMode = process.env.LLMHUB_CURSOR_AUTH_MODE
if (!['api_key', 'cli_login'].includes(authMode) ||
    (authMode === 'api_key' && !process.env.CURSOR_API_KEY)) {
  throw new Error('Worker requires explicit account authentication')
}
const workspace = await mkdtemp(join(tmpdir(), 'llmhub-cursor-'))
if (authMode === 'api_key') {
  // Establish an empty home before importing upstream. Its macOS keychain link
  // must never point at the gateway user's login in per-account key mode.
  const home = join(workspace, 'account-home')
  await mkdir(home, { mode: 0o700 })
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.XDG_CACHE_HOME = join(home, '.cache')
  process.env.XDG_DATA_HOME = join(home, '.local/share')
}
// loadEnvConfig auto-discovers account files even in resolveAgentCommand.
// A deliberately nonempty sentinel disables discovery; no pool is initialized,
// and the resulting configDirs is explicitly cleared below.
process.env.CURSOR_CONFIG_DIRS = workspace
// Keep upstream per-request temp directories under the worker-owned root.
process.env.TMPDIR = workspace
process.env.TMP = workspace
process.env.TEMP = workspace
const [{ loadBridgeConfig }, { handleChatCompletions }, { handleModels },
  { ToolSessionRegistry }] = await Promise.all([
  upstream('config'), upstream('handlers/chat-completions'), upstream('handlers/models'),
  upstream('tool-session-registry'),
])
const configuration = loadBridgeConfig({ env: process.env, cwd: workspace })
configuration.workspace = workspace
configuration.configDirs = []
configuration.sessionsLogPath = devNull
const toolSessions = new ToolSessionRegistry()
const context = { config: configuration, modelCacheRef: {}, lastRequestedModelRef: {}, toolSessions }
const secret = process.env.CURSOR_BRIDGE_API_KEY
let shuttingDown = false

function sendJSON(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

function authorized(request) {
  const scope = request.headers['x-llmhub-provider']
  if (typeof scope !== 'string' || scope.length > 256) return false
  const expected = Buffer.from(`Bearer ${createHmac('sha256', secret).update(scope).digest('hex')}`)
  const actual = Buffer.from(request.headers.authorization ?? '')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function readBody(request) {
  let size = 0
  const buffers = []
  for await (const buffer of request) {
    size += buffer.length
    if (size > 8 * 1024 * 1024) throw new Error('Cursor request exceeds 8 MiB')
    buffers.push(buffer)
  }
  return Buffer.concat(buffers).toString('utf8')
}

const server = createServer(async (request, response) => {
  // Do not mount upstream's request-listener: it exposes an unauthenticated
  // management dashboard before its API-key check. Only these routes exist.
  if (!authorized(request)) return sendJSON(response, 401, { error: { message: 'Unauthorized' } })
  try {
    if (request.method === 'GET' && ['/v1/account-identity', '/v1/subscription-usage'].includes(request.url)) {
      const controller = new AbortController()
      const cancel = () => controller.abort()
      response.on('close', cancel)
      try {
        const query = request.url === '/v1/account-identity' ? readAccountIdentity : readCLIUsage
        const result = await query(configuration.agentBin, {
          directory: workspace, signal: controller.signal,
        })
        if (!controller.signal.aborted) sendJSON(response, 200, result)
      } finally { response.off('close', cancel) }
      return
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      await handleModels(response, context)
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      return sendJSON(response, 404, { error: { message: 'Not found' } })
    }
    const rawBody = await readBody(request)
    const body = JSON.parse(rawBody)
    // Never allow callers to override the read-only mode via body or headers.
    if (body.mode !== undefined || request.headers['x-cursor-mode'] !== undefined) {
      return sendJSON(response, 400, { error: { message: 'Cursor execution mode is fixed to ask' } })
    }
    if (typeof body.model !== 'string' || !body.model || body.model === 'default') {
      return sendJSON(response, 400, { error: { message: 'An explicit model is required' } })
    }
    // Include model in the owner identity: a result cannot resume a session
    // under a changed model while the upstream reports a misleading model ID.
    request.headers.authorization += `:${body.model}`
    const messages = preserveToolHistory(body.messages)
    await handleChatCompletions(request, response, context,
      JSON.stringify({ ...body, messages }), 'POST', request.url, '127.0.0.1')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Cursor bridge failed'
    if (!response.headersSent) return sendJSON(response, 502, { error: { message } })
    if (!response.writableEnded) {
      response.end(`data: ${JSON.stringify({ error: { message } })}\n\ndata: [DONE]\n\n`)
    }
  }
})
server.requestTimeout = 15_000
server.headersTimeout = 10_000

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  server.close()
  server.closeAllConnections()
  const deadline = setTimeout(() => process.exit(1), 4_000)
  try {
    await Promise.all([toolSessions.closeAll(), supervision.shutdown()])
    await rm(workspace, { recursive: true, force: true })
    clearTimeout(deadline)
    process.exit(0)
  } catch {
    // Nothing from the account or request is logged during teardown.
    process.exit(1)
  }
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('disconnect', shutdown)
process.on('message', (message) => {
  if (message?.type === 'stop') void shutdown()
})
server.on('error', (error) => {
  process.send?.({ type: 'failed', code: error.code ?? 'START_FAILED' })
  void shutdown()
})
server.listen(Number(process.env.CURSOR_BRIDGE_PORT), '127.0.0.1', () => {
  process.send?.({ type: 'ready', port: server.address().port })
})
