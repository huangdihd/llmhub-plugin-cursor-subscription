import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { CursorBridge } from '../lib/bridge.mjs'
import { fromChatResponse } from '../lib/codec.mjs'

async function fixture(timeoutSeconds = 8, account = { auth_mode: 'cli_login' }) {
  const directory = await mkdtemp(join(tmpdir(), 'cursor-fixture-'))
  const executable = join(directory, 'agent.mjs')
  const log = join(directory, '.cursor-api-proxy/sessions.log')
  // Fake source keychain: without key-mode HOME isolation upstream would link it.
  await mkdir(join(directory, 'Library/Keychains'), { recursive: true })
  await mkdir(join(directory, '.cursor-api-proxy/accounts/poison'), { recursive: true })
  await writeFile(join(directory, '.cursor-api-proxy/accounts/poison/cli-config.json'),
    '{"authInfo":{"email":"fake@example.invalid"}}')
  await writeFile(log, 'unchanged\n')
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
if (process.argv.includes('--list-models')) {
  if (process.env.CURSOR_API_KEY && existsSync(join(process.env.HOME, 'Library/Keychains'))) {
    process.exit(3)
  }
  console.log('fixture - Fixture')
  if (process.env.CURSOR_API_KEY) console.log(process.env.CURSOR_API_KEY + ' - Account fixture')
  process.exit(0)
}
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
`, { mode: 0o700 })
  const bridge = new CursorBridge({ ...account, agent_binary: executable, timeout_seconds: timeoutSeconds }, {
    launch(module, argumentsList, options) {
      return fork(module, argumentsList, { ...options,
        env: { ...options.env, HOME: directory, USERPROFILE: directory } })
    },
  })
  return { bridge, directory, log, async cleanup() {
    await bridge.close()
    await rm(directory, { recursive: true, force: true })
  } }
}
const body = (content) => ({ model: 'fixture', messages: [{ role: 'user', content }] })

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
