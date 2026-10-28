import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { CursorBridge } from '../lib/bridge.mjs'
import { fromChatResponse } from '../lib/codec.mjs'

async function fixture(timeoutSeconds = 8, account = { auth_mode: 'cli_login' }, status = {
  value: { isAuthenticated: true, userInfo: { email: 'fixture@example.invalid' },
    token: 'STATUS_SECRET_SENTINEL' },
}) {
  const directory = await mkdtemp(join(tmpdir(), 'cursor-fixture-'))
  const executable = join(directory, 'agent.mjs')
  const log = join(directory, '.cursor-api-proxy/sessions.log')
  const statusFile = join(directory, 'status.json')
  const statusLog = join(directory, 'status.log')
  await writeFile(statusFile, JSON.stringify(status))
  await writeFile(statusLog, '')
  // Fake source keychain: without key-mode HOME isolation upstream would link it.
  await mkdir(join(directory, 'Library/Keychains'), { recursive: true })
  await mkdir(join(directory, '.cursor-api-proxy/accounts/poison'), { recursive: true })
  await writeFile(join(directory, '.cursor-api-proxy/accounts/poison/cli-config.json'),
    '{"authInfo":{"email":"fake@example.invalid"}}')
  await writeFile(log, 'unchanged\n')
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
if (process.argv[2] === 'status') {
  const status = JSON.parse(readFileSync(${JSON.stringify(statusFile)}, 'utf8'))
  appendFileSync(${JSON.stringify(statusLog)}, JSON.stringify(process.argv.slice(2)) + '\\n')
  if (status.hang) {
    process.on('SIGTERM', () => {
      appendFileSync(${JSON.stringify(statusLog)}, 'terminated\\n')
      process.exit(0)
    })
    setInterval(() => {}, 1000)
  } else {
    if (status.stderr) console.error(status.stderr)
    process.stdout.write(status.output ?? JSON.stringify(status.value), () => process.exit(status.exitCode ?? 0))
  }
} else if (process.argv.includes('--list-models')) {
  if (process.env.CURSOR_API_KEY && existsSync(join(process.env.HOME, 'Library/Keychains'))) {
    process.exit(3)
  }
  console.log('fixture - Fixture')
  if (process.env.CURSOR_API_KEY) console.log(process.env.CURSOR_API_KEY + ' - Account fixture')
  process.exit(0)
}
if (process.argv[2] === '--mode') {
  if (!process.stdin.isTTY) process.exit(7)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  console.log('Cursor Agent\\n→ Plan, search, build anything')
  let input = ''
  let selected = false
  process.stdin.on('data', chunk => {
    input += chunk.toString()
    if (input === '/usage' && !selected) {
      selected = true
      console.log('\\n→ /usage Show plan and on-demand usage')
    }
    if (!input.endsWith('\\r')) return
    if (input !== '/usage\\r' || !selected) process.exit(8)
    console.log('Usage • Premium     Resets Nov 2\\nMonthly plan and on-demand usage\\nCategory   Current   Usage\\nIncluded 23% used  ███░░\\nEsc to close')
  })
} else if (process.argv[2] !== 'status') {
const send = (value) => console.log(JSON.stringify({ jsonrpc: '2.0', ...value }))
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  const reply = (result) => send({ id: message.id, result })
  if (message.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: {} })
  if (message.method === 'session/new') return reply({ sessionId: 'fixture-session' })
  if (message.method !== 'session/prompt') return reply({})
  const prompt = JSON.stringify(message.params.prompt)
  if (prompt.includes('fail-sentinel')) {
    console.error('SENTINEL_SECRET_DO_NOT_LOG')
    process.exit(2)
  }
  let text = '你好 fixture'
  if (prompt.includes('hang-fixture')) text = 'started'
  if (prompt.includes('inspect-fixture')) {
    text = JSON.stringify({
      apiKey: process.env.CURSOR_API_KEY, home: process.env.HOME,
      keychainLinked: existsSync(join(process.env.HOME, 'Library/Keychains')),
    })
  }
  send({ method: 'session/update', params: { sessionId: 'fixture-session',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
  if (prompt.includes('hang-fixture')) {
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
    return
  }
  reply({ stopReason: 'end_turn' })
})
}
`, { mode: 0o700 })
  let workerSecret
  const bridge = new CursorBridge({ ...account, agent_binary: executable, timeout_seconds: timeoutSeconds }, {
    launch(module, argumentsList, options) {
      workerSecret = options.env.CURSOR_BRIDGE_API_KEY
      return fork(module, argumentsList, { ...options,
        env: { ...options.env, HOME: directory, USERPROFILE: directory } })
    },
  })
  return { bridge, directory, log, statusFile, statusLog,
    headers(scope = 'fixture-provider') {
      return { authorization: `Bearer ${createHmac('sha256', workerSecret).update(scope).digest('hex')}`,
        'x-llmhub-provider': scope }
    },
    async cleanup() {
      await bridge.close()
      await rm(directory, { recursive: true, force: true })
    } }
}
const body = (content) => ({ model: 'fixture', messages: [{ role: 'user', content }] })

async function waitForStatus(current, value) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if ((await readFile(current.statusLog, 'utf8')).includes(value)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`Fake CLI status did not report ${value}`)
}

test('real worker exposes authenticated official CLI usage through a real PTY, without inference', { timeout: 10000 }, async () => {
  const current = await fixture()
  try {
    const baseURL = await current.bridge.ensureReady()
    const denied = await fetch(`${baseURL}/v1/subscription-usage`)
    assert.equal(denied.status, 401)
    await denied.body.cancel()
    const wrongMethod = await fetch(`${baseURL}/v1/subscription-usage`, {
      method: 'POST', headers: current.headers(), body: '{}',
    })
    assert.equal(wrongMethod.status, 404)
    await wrongMethod.body.cancel()
    const result = await current.bridge.requestJSON('/v1/subscription-usage', 'fixture-provider')
    assert.deepEqual(result, { plan: 'Premium', used_percent: 23, reset_label: 'Resets Nov 2' })
    assert.equal(await readFile(current.statusLog, 'utf8'), '')
    assert.equal(await readFile(current.log, 'utf8'), 'unchanged\n')
  } finally { await current.cleanup() }
})

test('account identity is authenticated, read-only, uncached, and exposes only the CLI email', { timeout: 10000 }, async () => {
  const current = await fixture()
  try {
    const baseURL = await current.bridge.ensureReady()
    for (const headers of [{}, { 'x-llmhub-provider': 'fixture-provider', authorization: 'Bearer wrong' },
      { ...current.headers(), 'x-llmhub-provider': 'another-provider' }]) {
      const response = await fetch(`${baseURL}/v1/account-identity`, { headers })
      assert.equal(response.status, 401)
      assert.deepEqual(await response.json(), { error: { message: 'Unauthorized' } })
    }
    const wrongMethod = await fetch(`${baseURL}/v1/account-identity`, {
      method: 'POST', headers: current.headers(), body: '{}',
    })
    assert.equal(wrongMethod.status, 404)
    await wrongMethod.body.cancel()
    assert.equal(await readFile(current.statusLog, 'utf8'), '')

    const response = await fetch(`${baseURL}/v1/account-identity`, { headers: current.headers() })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.deepEqual(await response.json(), { email: 'fixture@example.invalid' })
    await writeFile(current.statusFile, JSON.stringify({ value: {
      isAuthenticated: true, userInfo: { email: 'rotated@example.invalid', token: 'ROTATED_SECRET_SENTINEL' },
    } }))
    assert.deepEqual(await current.bridge.requestJSON('/v1/account-identity', 'fixture-provider'),
      { email: 'rotated@example.invalid' })
    assert.deepEqual((await readFile(current.statusLog, 'utf8')).trim().split('\n').map(JSON.parse),
      [['status', '--format', 'json'], ['status', '--format', 'json']])
    assert.equal(await readFile(current.log, 'utf8'), 'unchanged\n')
  } finally { await current.cleanup() }
})

test('account identity returns sanitized errors for CLI authentication, JSON, exit and size failures', { timeout: 10000 }, async () => {
  const current = await fixture()
  const cases = [
    [{ value: { isAuthenticated: false, token: 'STATUS_SECRET_SENTINEL' } }, /authenticate this Provider/],
    [{ output: '{STATUS_SECRET_SENTINEL' }, /invalid JSON/],
    [{ value: { isAuthenticated: true, userInfo: { email: 'STATUS_SECRET_SENTINEL' } } }, /authenticate this Provider/],
    [{ output: 'STATUS_SECRET_SENTINEL', exitCode: 2, stderr: 'STDERR_SECRET_SENTINEL' }, /check this Provider’s CLI authentication/],
    [{ output: `STATUS_SECRET_SENTINEL${'x'.repeat(256 * 1024)}` }, /exceeds 256 KiB/],
  ]
  try {
    const baseURL = await current.bridge.ensureReady()
    for (const [status, expected] of cases) {
      await writeFile(current.statusFile, JSON.stringify(status))
      const response = await fetch(`${baseURL}/v1/account-identity`, { headers: current.headers() })
      assert.equal(response.status, 502)
      const error = await response.json()
      assert.deepEqual(Object.keys(error), ['error'])
      assert.match(error.error.message, expected)
      assert.ok(!JSON.stringify(error).includes('SECRET_SENTINEL'))
      await assert.rejects(current.bridge.requestJSON('/v1/account-identity', 'fixture-provider'),
        (error) => /HTTP 502/.test(error.message) && !error.message.includes('SECRET_SENTINEL'))
    }
    assert.equal(await readFile(current.log, 'utf8'), 'unchanged\n')
  } finally { await current.cleanup() }
})

test('key-auth account identity remains isolated per provider and never returns account secrets', { timeout: 10000 }, async () => {
  const identities = ['first', 'second']
  const currents = []
  try {
    for (const name of identities) {
      currents.push(await fixture(8, { cursor_api_key: `${name}-key` }, { value: {
        isAuthenticated: true, userInfo: { email: `${name}@example.invalid`, apiKey: `${name}-key` },
        token: `${name}-SESSION_SECRET_SENTINEL`,
      } }))
    }
    const responses = await Promise.all(currents.map((current, index) =>
      current.bridge.requestJSON('/v1/account-identity', identities[index])))
    assert.deepEqual(responses, identities.map((name) => ({ email: `${name}@example.invalid` })))
    for (const current of currents) assert.equal(await readFile(current.log, 'utf8'), 'unchanged\n')
  } finally { await Promise.all(currents.map((current) => current.cleanup())) }
})

test('account identity disconnect terminates its CLI and leaves the worker usable', { timeout: 10000 }, async () => {
  const current = await fixture(8, { auth_mode: 'cli_login' }, { hang: true })
  try {
    const controller = new AbortController()
    const pending = current.bridge.requestJSON('/v1/account-identity', 'fixture-provider', undefined, controller.signal)
    const rejected = assert.rejects(pending, { message: 'Cursor request cancelled' })
    await waitForStatus(current, '["status","--format","json"]')
    controller.abort(new Error('ABORT_SECRET_SENTINEL'))
    await rejected
    await waitForStatus(current, 'terminated')
    await writeFile(current.statusFile, JSON.stringify({ value: {
      isAuthenticated: true, userInfo: { email: 'recovered@example.invalid' },
    } }))
    assert.deepEqual(await current.bridge.requestJSON('/v1/account-identity', 'fixture-provider'),
      { email: 'recovered@example.invalid' })
    assert.equal(await readFile(current.log, 'utf8'), 'unchanged\n')
  } finally { await current.cleanup() }
})

test('account identity deadline cancels a hung CLI without exposing its output', { timeout: 10000 }, async () => {
  const current = await fixture(1, { auth_mode: 'cli_login' }, { hang: true })
  try {
    await current.bridge.ensureReady()
    await assert.rejects(current.bridge.requestJSON('/v1/account-identity', 'fixture-provider'),
      { message: 'Cursor request deadline exceeded' })
    await waitForStatus(current, 'terminated')
  } finally { await current.cleanup() }
})

test('real worker and fake CLI complete model discovery, JSON and SSE without real auth', { timeout: 10000 }, async () => {
  const current = await fixture()
  try {
    const models = await current.bridge.requestJSON('/v1/models', 'fixture-provider')
    assert.ok(models.data.some((model) => model.id === 'fixture'))
    const response = await current.bridge.requestJSON('/v1/chat/completions', 'fixture-provider', body('hello'))
    assert.deepEqual(fromChatResponse(response).content, [{ type: 'text', text: '你好 fixture' }])
    const stream = await current.bridge.requestStream('fixture-provider', body('hello'))
    const text = await new Response(stream).text()
    assert.ok(text.includes('你好 fixture'))
    assert.ok(text.includes('[DONE]'))
    assert.equal(await readFile(current.log, 'utf8'), 'unchanged\n')
  } finally { await current.cleanup() }
})

test('explicit CLI login retains its own source home for upstream authentication', { timeout: 10000 }, async () => {
  const current = await fixture()
  try {
    const response = await current.bridge.requestJSON('/v1/chat/completions', 'fixture-provider', body('inspect-fixture'))
    const environment = JSON.parse(fromChatResponse(response).content[0].text)
    assert.equal(environment.apiKey, undefined)
    if (process.platform === 'darwin') assert.equal(environment.keychainLinked, true)
  } finally { await current.cleanup() }
})

test('key-auth workers get different empty homes and their own explicit credentials', { timeout: 10000 }, async () => {
  const first = await fixture(8, { cursor_api_key: 'first-fixture-key' })
  const second = await fixture(8, { cursor_api_key: 'second-fixture-key' })
  try {
    const catalogs = await Promise.all([first, second].map((current) =>
      current.bridge.requestJSON('/v1/models', 'fixture-provider')))
    assert.ok(catalogs[0].data.some((model) => model.id === 'first-fixture-key'))
    assert.ok(!catalogs[0].data.some((model) => model.id === 'second-fixture-key'))
    assert.ok(catalogs[1].data.some((model) => model.id === 'second-fixture-key'))
    const responses = await Promise.all([first, second].map((current) =>
      current.bridge.requestJSON('/v1/chat/completions', 'fixture-provider', body('inspect-fixture'))))
    const [one, two] = responses.map((response) => JSON.parse(fromChatResponse(response).content[0].text))
    assert.equal(one.apiKey, 'first-fixture-key')
    assert.equal(two.apiKey, 'second-fixture-key')
    assert.notEqual(one.home, first.directory)
    assert.notEqual(two.home, second.directory)
    assert.notEqual(one.home, two.home)
    assert.equal(one.keychainLinked, false)
    assert.equal(two.keychainLinked, false)
    assert.equal(await readFile(first.log, 'utf8'), 'unchanged\n')
    assert.equal(await readFile(second.log, 'utf8'), 'unchanged\n')
  } finally { await Promise.all([first.cleanup(), second.cleanup()]) }
})

test('agent stderr never reaches persistent proxy log or public HTTP error', { timeout: 10000 }, async () => {
  const current = await fixture()
  try {
    await assert.rejects(current.bridge.requestJSON('/v1/chat/completions', 'fixture-provider', body('fail-sentinel')),
      (error) => /HTTP 50[02]/.test(error.message) && !error.message.includes('SENTINEL'))
    assert.equal(await readFile(current.log, 'utf8'), 'unchanged\n')
  } finally { await current.cleanup() }
})

test('request deadline covers response body, and stream cancel does not kill later requests', { timeout: 10000 }, async () => {
  const current = await fixture(3)
  try {
    const stream = await current.bridge.requestStream('fixture-provider', body('hang-fixture'))
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()
    const response = await current.bridge.requestJSON('/v1/chat/completions', 'fixture-provider', body('hello again'))
    assert.equal(fromChatResponse(response).finishReason, 'stop')
    await assert.rejects(current.bridge.requestJSON('/v1/chat/completions', 'fixture-provider', body('hang-fixture')),
      /deadline|HTTP 502/)
  } finally { await current.cleanup() }
})
