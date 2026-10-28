import assert from 'node:assert/strict'
import test from 'node:test'
import plugin from '../index.mjs'

function setup(configuration = {}) {
  let provider
  let change
  const cleanup = plugin.setup({
    config: configuration,
    registerProvider(definition) { provider = definition },
    onConfigChange(listener) { change = listener },
  })
  const adapter = provider.createAdapter({ name: 'cursor-account', use_custom_models: true,
    models: [{ id: 'sonnet', display_name: 'Sonnet' }] })
  return { provider, adapter, change, cleanup }
}

const request = { model: 'cursor-account/sonnet', config: {}, messages: [{ role: 'user', content: 'hello' }] }

test('setup registers a portable provider synchronously, without CLI startup', async () => {
  const { provider, adapter, cleanup } = setup({ agent_binary: '/does/not/exist' })
  assert.equal(provider.id, 'cursor')
  assert.deepEqual(provider.connectionSchema, [])
  assert.equal(adapter.toProviderRequest(request).model, 'sonnet')
  assert.deepEqual(adapter.getModels(), [{ id: 'cursor-account/sonnet', provider: 'cursor-account',
    name: 'sonnet', display_name: 'Sonnet', capabilities: { streaming: true, tools: false, vision: false } }])
  await assert.rejects(adapter.embed({}), /do not support embeddings/)
  assert.equal(cleanup(), undefined)
  await assert.rejects(adapter.call({}), /disabled/)
})

test('tools require explicit opt-in and capability metadata updates with configuration', () => {
  const { adapter, change, cleanup } = setup()
  const toolRequest = { ...request, tools: [{ name: 'lookup', description: 'lookup', parameters: {} }] }
  assert.throws(() => adapter.toProviderRequest(toolRequest), /experimental/)
  change({ enable_tools: true })
  assert.equal(adapter.toProviderRequest(toolRequest).tools[0].function.name, 'lookup')
  assert.equal(adapter.getModels()[0].capabilities.tools, true)
  assert.throws(() => change({ enable_tools: 'yes' }), /boolean/)
  change({ enable_tools: false })
  assert.throws(() => adapter.toProviderRequest(toolRequest), /experimental/)
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

test('invalid plugin configuration fails before provider registration', () => {
  assert.throws(() => setup({ bridge_port: -1 }), /bridge_port/)
})
