import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { preserveToolHistory } from '../lib/history.mjs'

const require = createRequire(import.meta.url)
const upstreamRoot = dirname(require.resolve('cursor-api-proxy/package.json'))
const { buildPromptFromMessages } = await import(pathToFileURL(join(upstreamRoot, 'dist/lib/openai.js')).href)
const { chatToolOutputs } = await import(pathToFileURL(join(upstreamRoot, 'dist/lib/tool-types.js')).href)

function calls(id) {
  return { role: 'assistant', content: '', tool_calls: [{ id, type: 'function',
    function: { name: 'lookup_weather', arguments: '{"city":"Beijing"}' } }] }
}
const result = (id) => ({ role: 'tool', tool_call_id: id, content: 'rainy' })

test('fresh prompts preserve completed call names, arguments and result IDs across multiple rounds', () => {
  const messages = [{ role: 'user', content: 'weather?' }, calls('one'), result('one'),
    { role: 'assistant', content: 'rainy' }, { role: 'user', content: 'again?' }, calls('two'), result('two'),
    { role: 'assistant', content: 'still rainy' }, { role: 'user', content: 'compare both results' }]
  const original = structuredClone(messages)
  const transformed = preserveToolHistory(messages)
  const prompt = buildPromptFromMessages(transformed)
  for (const value of ['lookup_weather', 'Beijing', 'one', 'two', 'rainy', 'compare both results']) {
    assert.ok(prompt.includes(value), value)
  }
  assert.deepEqual(chatToolOutputs(transformed), [])
  assert.deepEqual(messages, original)
})

test('live trailing results retain exact bodies and IDs for session resume', () => {
  const messages = [calls('current'), result('current')]
  const transformed = preserveToolHistory(messages)
  assert.equal(transformed[1], messages[1])
  assert.deepEqual(chatToolOutputs(transformed), [{ callId: 'current', output: 'rainy' }])
})

test('mixed live tool result plus new user message fails instead of losing continuation', () => {
  assert.throws(() => preserveToolHistory([calls('current'), result('current'),
    { role: 'user', content: 'and now?' }]), /must end with its tool results/)
})
