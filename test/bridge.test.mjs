import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { CursorBridge, normalizeSSE, parseConfiguration, workerEnvironment } from '../lib/bridge.mjs'

const encoder = new TextEncoder()

async function isolatedBridge(configuration) {
  const home = await mkdtemp(join(tmpdir(), 'cursor-test-home-'))
  const bridge = new CursorBridge({ auth_mode: 'cli_login', ...configuration }, {
    launch(module, argumentsList, options) {
      return fork(module, argumentsList, { ...options,
        env: { ...options.env, HOME: home, USERPROFILE: home } })
    },
  })
  return { bridge, async cleanup() { await bridge.close(); await rm(home, { recursive: true, force: true }) } }
}

async function collect(stream) {
  return new Response(stream).text()
}

function streamBytes(bytes) {
  let position = 0
  return new ReadableStream({
    pull(controller) {
      if (position === bytes.length) return controller.close()
      controller.enqueue(bytes.slice(position, ++position))
    },
  })
}

function fakeWorker(port, delay = 1) {
  const child = new EventEmitter()
  child.connected = true
  child.exitCode = null
  child.signalCode = null
  child.send = () => child.kill()
  child.kill = () => {
    child.exitCode = 0
    queueMicrotask(() => child.emit('exit', 0))
  }
  if (port) setTimeout(() => child.emit('message', { type: 'ready', port }), delay)
  return child
}

test('configuration validates boundaries and environment excludes gateway secrets and upstream overrides', () => {
  const configuration = parseConfiguration({ cursor_api_key: 'explicit-key' })
  assert.equal(configuration.port, 0)
  for (const value of [-1, 65536, 1.5, '123']) {
    assert.throws(() => parseConfiguration({ bridge_port: value }), /bridge_port/)
  }
  assert.throws(() => parseConfiguration({ timeout_seconds: 0 }), /timeout_seconds/)
  const environment = workerEnvironment(configuration, 'internal-secret', {
    HOME: '/login-home', PATH: '/bin', DATABASE_URL: 'private', OPENAI_API_KEY: 'private',
    NODE_OPTIONS: '--inspect', CURSOR_BRIDGE_FORCE: 'true', CURSOR_CONFIG_DIRS: '/accounts',
    CURSOR_API_KEY: 'inherited-key', CURSOR_API_ENDPOINT: 'http://untrusted',
  })
  assert.equal(environment.HOME, undefined)
  assert.equal(environment.LLMHUB_CURSOR_AUTH_MODE, 'api_key')
  assert.equal(environment.CURSOR_API_KEY, 'explicit-key')
  assert.equal(environment.CURSOR_BRIDGE_FORCE, 'false')
  assert.equal(environment.CURSOR_BRIDGE_USE_ACP, 'true')
  for (const key of ['DATABASE_URL', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'CURSOR_CONFIG_DIRS', 'CURSOR_API_ENDPOINT']) {
    assert.equal(environment[key], undefined)
  }
})

test('authentication never implicitly falls back to the server login', () => {
  assert.throws(() => parseConfiguration({}), /requires its own cursor_api_key/)
  assert.throws(() => parseConfiguration({ cursor_api_key: '  ' }), /requires its own/)
  assert.throws(() => parseConfiguration({ auth_mode: 'other' }), /auth_mode/)
  assert.throws(() => parseConfiguration({ auth_mode: 'cli_login', cursor_api_key: 'key' }), /cannot be combined/)
  const environment = workerEnvironment(parseConfiguration({ auth_mode: 'cli_login' }), 'secret', {
    HOME: '/explicit-login', CURSOR_API_KEY: 'must-not-leak', CURSOR_AUTH_TOKEN: 'must-not-leak',
  })
  assert.equal(environment.HOME, '/explicit-login')
  assert.equal(environment.CURSOR_API_KEY, undefined)
  assert.equal(environment.CURSOR_AUTH_TOKEN, undefined)
  assert.equal(environment.LLMHUB_CURSOR_AUTH_MODE, 'cli_login')
})

test('SSE supports split UTF-8, CRLF, multiline JSON, comments and missing space', async () => {
  let finished = 0
  const input = ': keepalive\r\nevent: chunk\r\ndata:{"text":\r\ndata: "你好"}\r\n\r\ndata:[DONE]\r\n\r\n'
  const result = await collect(normalizeSSE(streamBytes(encoder.encode(input)), () => finished++))
  assert.equal(result, 'data: {"text":"你好"}\n\ndata: [DONE]\n\n')
  assert.equal(finished, 1)
})

test('SSE errors are not disguised as successful termination', async () => {
  await assert.rejects(collect(normalizeSSE(streamBytes(encoder.encode('data: {}\n\n')))), /before \[DONE\]/)
  await assert.rejects(collect(normalizeSSE(streamBytes(encoder.encode('data: broken\n\n')))), SyntaxError)
})

test('SSE rejects invalid UTF-8, oversized events, and redacts upstream error details', async () => {
  await assert.rejects(collect(normalizeSSE(streamBytes(new Uint8Array([0xff])))), /encoded data/)
  const oversized = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(`data: ${'x'.repeat(8 * 1024 * 1024)}\n\n`))
    controller.close()
  } })
  await assert.rejects(collect(normalizeSSE(oversized)), /exceeds 8 MiB/)
  const errorFrame = encoder.encode('data: {"error":{"message":"SECRET_SENTINEL"}}\n\n')
  await assert.rejects(collect(normalizeSSE(streamBytes(errorFrame))),
    (error) => error.message.includes('Cursor stream failed') && !error.message.includes('SECRET_SENTINEL'))
})

test('SSE cancellation releases and cancels upstream', async () => {
  let cancelled = false
  let aborted = false
  let finished = false
  const stream = normalizeSSE(new ReadableStream({ cancel() { cancelled = true } }),
    () => { finished = true }, () => { aborted = true })
  await stream.cancel('client stopped')
  assert.ok(cancelled && aborted && finished)
})

test('bridge startup is single-flight and close is terminal', async () => {
  let starts = 0
  const bridge = new CursorBridge({ auth_mode: 'cli_login' }, { launch: () => { starts++; return fakeWorker(12345) } })
  const [first, second] = await Promise.all([bridge.ensureReady(), bridge.ensureReady()])
  assert.equal(first, second)
  assert.equal(starts, 1)
  await bridge.close()
  await assert.rejects(bridge.ensureReady(), /closed/)
})

test('startup timeout terminates owned child', async () => {
  const child = fakeWorker()
  const bridge = new CursorBridge({ auth_mode: 'cli_login' }, { launch: () => child, startupMilliseconds: 20 })
  await assert.rejects(bridge.ensureReady(), /startup timed out/)
  await bridge.close()
  assert.equal(child.exitCode, 0)
})

test('close during startup rejects readiness rather than hanging', async () => {
  const bridge = new CursorBridge({ auth_mode: 'cli_login' }, { launch: () => fakeWorker(12345, 30) })
  const ready = bridge.ensureReady()
  const rejected = assert.rejects(ready, /exited/)
  await bridge.close()
  await rejected
})

test('real worker binds an ephemeral port and refuses unauthenticated management/API requests', async () => {
  // Empty HOME plus disabled account discovery: no real login files are used.
  const { bridge, cleanup } = await isolatedBridge({ agent_binary: process.execPath })
  try {
    const baseURL = await bridge.ensureReady()
    const response = await fetch(`${baseURL}/api/status`)
    assert.equal(response.status, 401)
    await response.body.cancel()
    const models = await fetch(`${baseURL}/v1/models`)
    assert.equal(models.status, 401)
    await models.body.cancel()
  } finally {
    await cleanup()
  }
})

test('occupied port fails without adopting or stopping the unrelated listener', async () => {
  const server = createServer((request, response) => response.end('unrelated'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const { bridge, cleanup } = await isolatedBridge({ agent_binary: process.execPath, bridge_port: port })
  try {
    await assert.rejects(bridge.ensureReady(), /EADDRINUSE/)
    const response = await fetch(`http://127.0.0.1:${port}`)
    assert.equal(await response.text(), 'unrelated')
  } finally {
    await cleanup()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('pre-aborted external requests never launch a worker or expose the abort reason', async () => {
  let starts = 0
  const bridge = new CursorBridge({ auth_mode: 'cli_login' }, {
    launch() { starts++; return fakeWorker(12345) },
  })
  const controller = new AbortController()
  controller.abort(new Error('ABORT_SECRET_SENTINEL'))
  try {
    await assert.rejects(bridge.requestJSON('/v1/account-identity', 'one', undefined, controller.signal),
      { message: 'Cursor request cancelled' })
    assert.equal(starts, 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  } finally { await bridge.close() }
})

test('external cancellation during startup releases only its request and preserves shared readiness', async () => {
  const child = fakeWorker()
  const bridge = new CursorBridge({ auth_mode: 'cli_login' }, { launch: () => child })
  const controller = new AbortController()
  try {
    const pending = bridge.requestJSON('/v1/account-identity', 'one', undefined, controller.signal)
    const rejected = assert.rejects(pending, { message: 'Cursor request cancelled' })
    const ready = bridge.ensureReady()
    controller.abort(new Error('ABORT_SECRET_SENTINEL'))
    await rejected
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.equal(child.exitCode, null)
    child.emit('message', { type: 'ready', port: 12345 })
    assert.equal(await ready, 'http://127.0.0.1:12345')
  } finally { await bridge.close() }
})

test('external abort closes pending headers and partial JSON without cancelling another request', { timeout: 10000 }, async (context) => {
  for (const partialBody of [false, true]) {
    await context.test(partialBody ? 'while reading JSON body' : 'while waiting for headers', async () => {
      let received
      let disconnected
      const started = new Promise((resolve) => { received = resolve })
      const closed = new Promise((resolve) => { disconnected = resolve })
      const server = createServer((request, response) => {
        if (request.url === '/v1/models') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"data":[]}')
          return
        }
        response.on('close', disconnected)
        if (partialBody) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.write('{"email":"')
        }
        received()
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const child = fakeWorker(server.address().port)
      const bridge = new CursorBridge({ auth_mode: 'cli_login' }, { launch: () => child })
      const controller = new AbortController()
      try {
        const pending = bridge.requestJSON('/v1/account-identity', 'one', undefined, controller.signal)
        const rejected = assert.rejects(pending, (error) => {
          assert.ok(error.name === 'AbortError' || error.message === 'Cursor request cancelled')
          assert.ok(!error.message.includes('SECRET_SENTINEL'))
          return true
        })
        await started
        const concurrent = bridge.requestJSON('/v1/models', 'two')
        controller.abort(new Error('ABORT_SECRET_SENTINEL'))
        await rejected
        await closed
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
        assert.equal(child.exitCode, null)
        assert.deepEqual(await concurrent, { data: [] })
        assert.deepEqual(await bridge.requestJSON('/v1/models', 'one'), { data: [] })
      } finally {
        await bridge.close()
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      }
    })
  }
})

test('external abort listeners are removed after success, HTTP failure and deadline', { timeout: 10000 }, async () => {
  const server = createServer((request, response) => {
    if (request.url === '/hang') return
    response.writeHead(request.url === '/fail' ? 502 : 200, { 'content-type': 'application/json' })
    response.end(request.url === '/fail' ? '{"error":"HTTP_SECRET_SENTINEL"}' : '{"data":[]}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const child = fakeWorker(server.address().port)
  const bridge = new CursorBridge({ auth_mode: 'cli_login', timeout_seconds: 1 }, { launch: () => child })
  try {
    for (const path of ['/v1/models', '/fail', '/hang']) {
      const controller = new AbortController()
      const pending = bridge.requestJSON(path, 'one', undefined, controller.signal)
      if (path === '/v1/models') assert.deepEqual(await pending, { data: [] })
      else await assert.rejects(pending, (error) => {
        assert.match(error.message, path === '/fail' ? /HTTP 502/ : /deadline exceeded/)
        assert.ok(!error.message.includes('SECRET_SENTINEL'))
        return true
      })
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      controller.abort(new Error('LATE_ABORT_SECRET_SENTINEL'))
      assert.equal(child.exitCode, null)
    }
    assert.deepEqual(await bridge.requestJSON('/v1/models', 'one'), { data: [] })
  } finally {
    await bridge.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('HTTP scope tokens differ across providers and cancellation closes the stream request', async () => {
  const tokens = []
  let disconnected
  const closed = new Promise((resolve) => { disconnected = resolve })
  const server = createServer((request, response) => {
    tokens.push(request.headers.authorization)
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"data":[]}')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[]}\n\n')
    response.on('close', disconnected)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const bridge = new CursorBridge({ auth_mode: 'cli_login' }, { launch: () => fakeWorker(server.address().port) })
  try {
    await bridge.requestJSON('/v1/models', 'one')
    await bridge.requestJSON('/v1/models', 'two')
    assert.notEqual(tokens[0], tokens[1])
    const stream = await bridge.requestStream('one', { messages: [] })
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()
    await closed
  } finally {
    await bridge.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
