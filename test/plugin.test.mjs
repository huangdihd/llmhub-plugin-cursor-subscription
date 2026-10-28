import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import plugin from '../index.mjs'

function providerConfiguration(extra = {}) {
  return { name: 'cursor-account', use_custom_models: true,
    connection: { extra: { cursor_api_key: 'fixture-key', ...extra } },
    models: [{ id: 'sonnet', display_name: 'Sonnet' }] }
}

function setup(configuration = {}) {
  const warnings = []
  let provider
  let change
  const cleanup = plugin.setup({
    config: configuration,
    logger: { warn(message) { warnings.push(message) } },
    registerProvider(definition) { provider = definition },
    onConfigChange(listener) { change = listener },
  })
  const adapter = provider.createAdapter(providerConfiguration())
  return { provider, adapter, change, cleanup, warnings }
}

const request = { model: 'cursor-account/sonnet', config: {}, messages: [{ role: 'user', content: 'hello' }] }

test('setup registers per-provider credentials synchronously, without CLI startup', async () => {
  const { provider, adapter, cleanup } = setup({ agent_binary: '/does/not/exist' })
  assert.equal(provider.id, 'cursor')
  assert.deepEqual(provider.secretConnectionFields, ['extra.cursor_api_key'])
  assert.deepEqual(provider.connectionSchema.map((field) => field.key),
    ['auth_mode', 'cursor_api_key', 'enable_tools', 'timeout_seconds'])
  assert.equal(adapter.toProviderRequest(request).model, 'sonnet')
  assert.deepEqual(adapter.getModels(), [{ id: 'cursor-account/sonnet', provider: 'cursor-account',
    name: 'sonnet', display_name: 'Sonnet', capabilities: { streaming: true, tools: false, vision: false } }])
  await assert.rejects(adapter.embed({}), /do not support embeddings/)
  assert.equal(cleanup(), undefined)
  await assert.rejects(adapter.call({}), /disabled/)
})

test('tools are per-provider opt-in and old adapters cannot reuse replaced credentials', async () => {
  const { provider, adapter, cleanup } = setup()
  const toolRequest = { ...request, tools: [{ name: 'lookup', description: 'lookup', parameters: {} }] }
  assert.throws(() => adapter.toProviderRequest(toolRequest), /experimental/)
  const enabled = provider.createAdapter(providerConfiguration({ enable_tools: true }))
  assert.equal(enabled.toProviderRequest(toolRequest).tools[0].function.name, 'lookup')
  assert.equal(enabled.getModels()[0].capabilities.tools, true)
  assert.throws(() => adapter.toProviderRequest(request), /configuration changed/)
  await assert.rejects(adapter.call({}), /configuration changed/)
  assert.throws(() => provider.createAdapter(providerConfiguration({ enable_tools: 'yes' })), /boolean/)
  assert.equal(enabled.getModels()[0].capabilities.tools, true)
  const other = provider.createAdapter({ ...providerConfiguration(), name: 'another-account' })
  assert.equal(other.getModels()[0].capabilities.tools, false)
  cleanup()
})

test('model selection never inherits another caller’s last model', () => {
  const { adapter, cleanup } = setup()
  for (const model of [undefined, 'default', 'cursor-account/default']) {
    assert.throws(() => adapter.toProviderRequest({ ...request, model }), /explicit Cursor model/)
  }
  for (const model of ['other/sonnet', ' sonnet ', 'cursor-account/vendor/sonnet']) {
    assert.throws(() => adapter.toProviderRequest({ ...request, model }), /unqualified/)
  }
  cleanup()
})

test('legacy settings allow activation without becoming shared account defaults or leaking secrets', () => {
  const configuration = { cursor_api_key: 'old-key-sentinel', bridge_port: 1234,
    enable_tools: true, timeout_seconds: 60 }
  const { provider, adapter, change, cleanup, warnings } = setup(configuration)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /retained but unused/)
  assert.ok(!warnings[0].includes(configuration.cursor_api_key))
  assert.throws(() => provider.createAdapter({ name: 'unmigrated' }), /requires its own cursor_api_key/)
  assert.equal(adapter.getModels()[0].capabilities.tools, false)
  change({ ...configuration, cursor_api_key: 'replacement-legacy-key' })
  assert.equal(adapter.getModels().length, 1)
  assert.equal(warnings.length, 2)
  cleanup()
  const defaults = setup({ cursor_api_key: '', bridge_port: 0, enable_tools: false, timeout_seconds: 180 })
  assert.deepEqual(defaults.warnings, [])
  defaults.cleanup()
})

test('manifest retains legacy schema keys and secret masking for host upgrade validation', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const fields = new Map(manifest.llmhub.configSchema.map((field) => [field.key, field]))
  for (const [key, type] of Object.entries({ agent_binary: 'text', cursor_api_key: 'secret',
    bridge_port: 'number', enable_tools: 'boolean', timeout_seconds: 'number' })) {
    assert.equal(fields.get(key)?.type, type)
    assert.notEqual(fields.get(key)?.required, true)
  }
})

test('plugin path changes invalidate existing adapters, but invalid changes leave them usable', () => {
  const { provider, adapter, change, cleanup } = setup()
  assert.throws(() => change({ agent_binary: 7 }), /string/)
  assert.equal(adapter.getModels().length, 1)
  change({ agent_binary: '/new/agent' })
  assert.throws(() => adapter.getModels(), /configuration changed/)
  const replacement = provider.createAdapter(providerConfiguration())
  assert.equal(replacement.getModels().length, 1)
  cleanup()
})
