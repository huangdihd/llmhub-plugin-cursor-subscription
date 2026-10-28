import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { CursorBridge } from '../lib/bridge.mjs'
import { fromChatResponse } from '../lib/codec.mjs'

async function fixture(timeoutSeconds = 8) {
  const directory = await mkdtemp(join(tmpdir(), 'cursor-fixture-'))
  const executable = join(directory, 'agent.mjs')
  const log = join(directory, '.cursor-api-proxy/sessions.log')
  await mkdir(join(directory, '.cursor-api-proxy/accounts/poison'), { recursive: true })
  await writeFile(join(directory, '.cursor-api-proxy/accounts/poison/cli-config.json'),
    '{"authInfo":{"email":"fake@example.invalid"}}')
  await writeFile(log, 'unchanged\n')
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline'
if (process.argv.includes('--list-models')) {
  console.log('fixture - Fixture')
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
  const text = prompt.includes('hang-fixture') ? 'started' : '你好 fixture'
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
  const bridge = new CursorBridge({ agent_binary: executable, timeout_seconds: timeoutSeconds }, {
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
