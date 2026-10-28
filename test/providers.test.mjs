import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderAccounts } from '../lib/providers.mjs'

const provider = (name, extra = {}) => ({ name,
  connection: { extra: { cursor_api_key: `${name}-key`, ...extra } } })

function fixture({ delayClose = false } = {}) {
  const bridges = []
  const accounts = new ProviderAccounts({}, (configuration) => {
    let finish
    const stopped = delayClose ? new Promise((resolve) => { finish = resolve }) : Promise.resolve()
    const bridge = { configuration, closed: false, finish,
      close() { this.closed = true; return stopped } }
    bridges.push(bridge)
    return bridge
  })
  return { accounts, bridges }
}

test('each provider has independent credentials, worker and catalog; unchanged bindings reuse them', async () => {
  const { accounts, bridges } = fixture()
  const first = accounts.bind(provider('first', { timeout_seconds: 12, enable_tools: true }))
  const second = accounts.bind(provider('second'))
  const [one, two] = await Promise.all([first.bridge(), second.bridge()])
  assert.notEqual(one, two)
  assert.equal(one.configuration.cursor_api_key, 'first-key')
  assert.equal(two.configuration.cursor_api_key, 'second-key')
  assert.equal(one.configuration.timeout_seconds, 12)
  assert.equal(first.toolsEnabled, true)
  assert.equal(second.toolsEnabled, false)
  first.saveModels(['first-model'])
  second.saveModels(['second-model'])
  assert.deepEqual(first.models(), ['first-model'])
  assert.deepEqual(second.models(), ['second-model'])
  assert.equal(accounts.bind(provider('second')), second)
  assert.equal(accounts.bind(provider('second'), { discovery: true }), second)
  assert.equal(await second.bridge(), two)
  assert.equal(bridges.length, 2)
  await accounts.close()
})

test('rotation cancels only its own worker, waits for shutdown and rejects stale adapters and discovery', async () => {
  const { accounts } = fixture({ delayClose: true })
  const first = accounts.bind(provider('first'))
  const second = accounts.bind(provider('second'))
  const one = await first.bridge()
  const two = await second.bridge()
  const rotated = accounts.bind(provider('first', { cursor_api_key: 'rotated-key' }))
  assert.equal(one.closed, true)
  assert.equal(two.closed, false)
  await assert.rejects(first.bridge(), /configuration changed/)
  assert.throws(() => first.saveModels(['stale-model']), /configuration changed/)
  assert.throws(() => accounts.bind(provider('first'), { discovery: true }), /reload adapters/)
  let started = false
  const pending = rotated.bridge().then((bridge) => { started = true; return bridge })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, false)
  one.finish()
  const replacement = await pending
  assert.equal(replacement.configuration.cursor_api_key, 'rotated-key')
  assert.deepEqual(rotated.models(), [])
  replacement.finish()
  two.finish()
  await accounts.close()
})

test('rapid reconfiguration retains the full shutdown chain and never revives an old generation', async () => {
  const { accounts, bridges } = fixture({ delayClose: true })
  const first = accounts.bind(provider('first'))
  const one = await first.bridge()
  accounts.configure({ agent_binary: '/second/agent' })
  const second = accounts.bind(provider('first'))
  const pending = second.bridge()
  const rejected = assert.rejects(pending, /configuration changed/)
  accounts.configure({ agent_binary: '/third/agent' })
  const third = accounts.bind(provider('first'))
  const latest = third.bridge()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(bridges.length, 1)
  one.finish()
  await rejected
  const current = await latest
  assert.equal(current.configuration.agent_binary, '/third/agent')
  assert.equal(bridges.length, 2)
  current.finish()
  await accounts.close()
})

test('cleanup during pending rotation blocks worker creation', async () => {
  const { accounts, bridges } = fixture({ delayClose: true })
  const first = accounts.bind(provider('first'))
  const one = await first.bridge()
  const replacement = accounts.bind(provider('first', { cursor_api_key: 'replacement' }))
  const rejected = assert.rejects(replacement.bridge(), /disabled/)
  const closed = accounts.close()
  one.finish()
  await Promise.all([rejected, closed])
  assert.equal(bridges.length, 1)
})

test('CLI login must be explicit and is reserved to one provider per plugin instance', async () => {
  const { accounts } = fixture()
  assert.throws(() => accounts.bind({ name: 'missing' }), /requires its own/)
  const local = (name) => provider(name, { auth_mode: 'cli_login', cursor_api_key: '' })
  accounts.bind(local('first'))
  assert.throws(() => accounts.bind(local('second')), /already bound/)
  accounts.configure({ agent_binary: '/changed/agent' })
  assert.throws(() => accounts.bind(local('second')), /already bound/)
  accounts.bind(provider('first'))
  accounts.bind(local('second'))
  await accounts.close()
})

test('CLI ownership transfer waits for the previous provider’s worker to exit', async () => {
  const { accounts, bridges } = fixture({ delayClose: true })
  const local = (name) => provider(name, { auth_mode: 'cli_login', cursor_api_key: '' })
  const first = accounts.bind(local('first'))
  const one = await first.bridge()
  accounts.bind(provider('first'))
  const second = accounts.bind(local('second'))
  const pending = second.bridge()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(one.closed, true)
  assert.equal(bridges.length, 1)
  one.finish()
  const two = await pending
  assert.equal(bridges.length, 2)
  assert.equal(two.configuration.auth_mode, 'cli_login')
  two.finish()
  await accounts.close()
})

test('providers sharing a supplied key still never share a worker', async () => {
  const { accounts } = fixture()
  const first = accounts.bind(provider('first', { cursor_api_key: 'same-key' }))
  const second = accounts.bind(provider('second', { cursor_api_key: 'same-key' }))
  assert.notEqual(await first.bridge(), await second.bridge())
  await accounts.close()
})
