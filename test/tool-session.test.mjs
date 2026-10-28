import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { preserveToolHistory } from '../lib/history.mjs'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('cursor-api-proxy/package.json'))
const { ToolSessionRegistry } = await import(pathToFileURL(join(root, 'dist/lib/tool-session-registry.js')).href)

function session() {
  const pending = new Set(['first', 'second'])
  const received = []
  return {
    closed: false, terminal: false, received,
    hasCall(id) { return pending.has(id) },
    async resume(outputs) {
      for (const output of outputs) {
        received.push(output.callId)
        pending.delete(output.callId)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { status: 'tool_calls' }
    },
    async close() { this.closed = true },
  }
}

test('upstream tool registry isolates owner keys, accepts unordered batches, rejects replay under its mutex', async () => {
  const registry = new ToolSessionRegistry()
  const active = session()
  const record = registry.createRecord({ api: 'chat', ownerKey: 'provider-one:model-one', model: 'fixture', session: active })
  assert.equal(registry.findByCallIds('chat', 'provider-two:model-one', ['first']), undefined)
  assert.equal(registry.findByCallIds('chat', 'provider-one:model-two', ['first']), undefined)
  assert.equal(registry.findByCallIds('chat', 'provider-one:model-one', ['first']), record)
  const outputs = [{ callId: 'second', output: 'two' }, { callId: 'first', output: 'one' }]
  const results = await Promise.allSettled([registry.resume(record, outputs), registry.resume(record, outputs)])
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected'])
  assert.match(results[1].reason.message, /already resolved/)
  assert.deepEqual(active.received, ['second', 'first'])
  assert.equal(registry.findByCallIds('chat', 'provider-one:model-one', ['first']), undefined)
  await registry.closeAll()
  assert.equal(active.closed, true)
})

test('duplicate results are rejected before upstream partially settles a batch', () => {
  const result = { role: 'tool', tool_call_id: 'same', content: 'value' }
  assert.throws(() => preserveToolHistory([result, result]), /duplicate result IDs/)
})
