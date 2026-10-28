import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import test from 'node:test'
import { readAccountIdentity } from '../lib/identity.mjs'

const email = 'fixture@example.invalid'
const authenticated = (value = email) => ({ isAuthenticated: true, userInfo: { email: value } })

function fixture(options = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  const signals = []
  child.kill = (signal) => { signals.push(signal); return true }
  let invocation
  const result = readAccountIdentity('/fixture/agent', {
    directory: '/fixture/workspace', timeoutMilliseconds: 1000, ...options,
    launch(executable, argumentsList, configuration) {
      invocation = { executable, argumentsList, configuration }
      return child
    },
  })
  return { child, signals, invocation, result,
    output(value) { child.stdout.emit('data', Buffer.from(value)) },
    complete(value, code = 0) { this.output(JSON.stringify(value)); child.emit('close', code) },
  }
}

test('identity invokes only official CLI status and returns only the validated email', async () => {
  const controller = new AbortController()
  const current = fixture({ signal: controller.signal })
  assert.equal(current.invocation.executable, '/fixture/agent')
  assert.deepEqual(current.invocation.argumentsList, ['status', '--format', 'json'])
  assert.equal(current.invocation.configuration.cwd, '/fixture/workspace')
  assert.equal(current.invocation.configuration.detached, true)
  assert.deepEqual(current.invocation.configuration.stdio, ['ignore', 'pipe', 'ignore'])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  const bytes = Buffer.from(JSON.stringify({ ...authenticated(), token: 'SECRET_SENTINEL',
    userInfo: { email, name: '你好', session: 'SESSION_SECRET_SENTINEL' } }))
  for (const byte of bytes) current.output([byte])
  current.child.emit('close', 0)
  assert.deepEqual(await current.result, { email })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  controller.abort(new Error('ABORT_SECRET_SENTINEL'))
  current.child.emit('error', new Error('LATE_SECRET_SENTINEL'))
  current.child.emit('close', 1)
  assert.deepEqual(current.signals, [])
})

test('identity requires boolean authentication and a bounded, usable email', async (context) => {
  const invalid = [
    null, [], 'SECRET_SENTINEL', {},
    { ...authenticated(), isAuthenticated: false },
    { ...authenticated(), isAuthenticated: 'true' },
    { userInfo: { email } },
    { isAuthenticated: true },
    { isAuthenticated: true, userInfo: null },
    { isAuthenticated: true, userInfo: {} },
    ...[null, 42, [], '', 'no-at-sign', '@example.invalid', 'user@', 'a@b@c',
      ' user@example.invalid', 'user@example.invalid\n', 'user name@example.invalid',
      `${'x'.repeat(319)}@a`].map(authenticated),
  ]
  for (const [index, value] of invalid.entries()) {
    await context.test(`rejects invalid identity ${index + 1}`, async () => {
      const current = fixture()
      current.complete(value)
      await assert.rejects(current.result, {
        message: 'Cursor identity unavailable; authenticate this Provider before querying quota',
      })
      assert.deepEqual(current.signals, ['SIGTERM'])
    })
  }
  const maximumEmail = `${'x'.repeat(318)}@a`
  const current = fixture()
  current.complete(authenticated(maximumEmail))
  assert.deepEqual(await current.result, { email: maximumEmail })
})

test('identity rejects empty, malformed and concatenated JSON without exposing stdout', async (context) => {
  for (const output of ['', '{"token":"SECRET_SENTINEL"', 'SECRET_SENTINEL', '{}{}']) {
    await context.test(`rejects ${output.length}-byte invalid JSON`, async () => {
      const current = fixture()
      current.output(output)
      current.child.emit('close', 0)
      await assert.rejects(current.result, { message: 'Cursor identity query returned invalid JSON' })
      assert.deepEqual(current.signals, ['SIGTERM'])
    })
  }
})

test('identity treats nonzero and signalled exits as authentication failures even with valid stdout', async () => {
  for (const code of [1, 2, null]) {
    const current = fixture()
    current.complete({ ...authenticated(), token: 'SECRET_SENTINEL' }, code)
    await assert.rejects(current.result, {
      message: 'Cursor identity query failed; check this Provider’s CLI authentication',
    })
    assert.deepEqual(current.signals, ['SIGTERM'])
  }
})

test('identity redacts spawn errors and ignores events after failure', async () => {
  const controller = new AbortController()
  const current = fixture({ signal: controller.signal })
  current.child.emit('error', new Error('SPAWN_SECRET_SENTINEL'))
  await assert.rejects(current.result, { message: 'Cursor identity query could not start' })
  current.complete(authenticated())
  current.child.emit('error', new Error('LATE_SECRET_SENTINEL'))
  controller.abort()
  assert.deepEqual(current.signals, ['SIGTERM'])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('identity accepts exactly 256 KiB and rejects one extra byte before child exit', async () => {
  const prefix = Buffer.from(JSON.stringify(authenticated()))
  const maximum = Buffer.concat([prefix, Buffer.alloc(256 * 1024 - prefix.length, ' ')])
  const accepted = fixture()
  accepted.output(maximum.subarray(0, 128 * 1024))
  accepted.output(maximum.subarray(128 * 1024))
  accepted.child.emit('close', 0)
  assert.deepEqual(await accepted.result, { email })
  assert.deepEqual(accepted.signals, [])

  const rejected = fixture()
  rejected.output(maximum)
  rejected.output(' ')
  await assert.rejects(rejected.result, { message: 'Cursor identity response exceeds 256 KiB' })
  rejected.output('SECRET_SENTINEL')
  rejected.child.emit('close', 0)
  assert.deepEqual(rejected.signals, ['SIGTERM'])
})

test('an already aborted identity query never launches the CLI or propagates the abort reason', async () => {
  const controller = new AbortController()
  controller.abort(new Error('ABORT_SECRET_SENTINEL'))
  let launches = 0
  await assert.rejects(readAccountIdentity('/fixture/agent', {
    signal: controller.signal, launch() { launches++; throw new Error('must not launch') },
  }), { message: 'Cursor identity query cancelled' })
  assert.equal(launches, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('identity cancellation terminates the child once and removes its listener', async () => {
  const controller = new AbortController()
  const current = fixture({ signal: controller.signal })
  current.output('{"token":"SECRET_SENTINEL"')
  controller.abort(new Error('ABORT_SECRET_SENTINEL'))
  await assert.rejects(current.result, { message: 'Cursor identity query cancelled' })
  current.child.emit('close', 0)
  current.child.emit('error', new Error('LATE_SECRET_SENTINEL'))
  assert.deepEqual(current.signals, ['SIGTERM'])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('identity deadline includes waiting for process exit, not just receiving valid JSON', async () => {
  const controller = new AbortController()
  const current = fixture({ signal: controller.signal, timeoutMilliseconds: 15 })
  current.output(JSON.stringify(authenticated()))
  await assert.rejects(current.result, { message: 'Cursor identity query timed out' })
  controller.abort(new Error('ABORT_SECRET_SENTINEL'))
  current.child.emit('close', 0)
  assert.deepEqual(current.signals, ['SIGTERM'])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
