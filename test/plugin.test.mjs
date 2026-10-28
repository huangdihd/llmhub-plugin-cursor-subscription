import assert from 'node:assert/strict'
import test from 'node:test'
import plugin from '../index.mjs'

function providerConfiguration(extra = {}) {
  return { name: 'cursor-account', use_custom_models: true,
    connection: { extra: { cursor_api_key: 'fixture-key', ...extra } },
    models: [{ id: 'sonnet', display_name: 'Sonnet' }] }
}

function setup(configuration = {}) {
  let provider
  let change
  const cleanup = plugin.setup({
    config: configuration,
    registerProvider(definition) { provider = definition },
    onConfigChange(listener) { change = listener },
  })
  const adapter = provider.createAdapter(providerConfiguration())
  return { provider, adapter, change, cleanup }
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

test('legacy nondefault global account settings require explicit migration', () => {
  for (const configuration of [{ cursor_api_key: 'old-key' }, { bridge_port: 1234 },
    { enable_tools: true }, { timeout_seconds: 60 }]) {
    assert.throws(() => setup(configuration), /Migrate plugin-global/)
  }
  const { cleanup } = setup({ cursor_api_key: '', bridge_port: 0, enable_tools: false, timeout_seconds: 180 })
  cleanup()
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
