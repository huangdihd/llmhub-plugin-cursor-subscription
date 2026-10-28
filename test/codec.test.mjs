import assert from 'node:assert/strict'
import test from 'node:test'
import { fromChatChunk, fromChatResponse, toChatRequest } from '../lib/codec.mjs'

const unknownUsage = { promptTokens: 0, completionTokens: 0 }
const tool = { name: 'lookup', description: 'Find a record', parameters: { type: 'object', properties: { query: { type: 'string' } } } }
const toolCall = { id: 'call-1', name: 'lookup', input: { query: '维拉' } }
const wireToolCall = { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"维拉"}' } }

function request(overrides = {}) {
  return { model: 'cursor/model', messages: [{ role: 'user', content: 'hello' }], config: {}, ...overrides }
}

function response(message = { role: 'assistant', content: 'hello' }, overrides = {}) {
  return { choices: [{ index: 0, message, finish_reason: 'stop' }], ...overrides }
}

function chunk(delta = {}, finishReason = null, overrides = {}) {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }], ...overrides }
}

function freeze(value) {
  if (!value || typeof value !== 'object') return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}

test('request strips only the exact provider prefix, once', () => {
  for (const [model, expected] of [
    ['cursor/model', 'model'],
    ['cursor/vendor/model', 'vendor/model'],
    ['cursor/cursor/model', 'cursor/model'],
    ['cursor-other/model', 'cursor-other/model'],
    ['other/model', 'other/model'],
    ['Cursor/model', 'Cursor/model'],
    ['model', 'model'],
  ]) assert.equal(toChatRequest(request({ model }), 'cursor').model, expected)
  assert.equal(toChatRequest(request({ model: 'local.+/model' }), 'local.+').model, 'model')
  assert.equal('model' in toChatRequest(request({ model: undefined }), 'cursor'), false)
  for (const model of ['', ' ', 'cursor/', 2, null]) {
    assert.throws(() => toChatRequest(request({ model }), 'cursor'), /model/)
  }
})

test('request preserves all text roles, name metadata and system prompt without sanitizing', () => {
  const text = 'Claude Code / Anthropic / x-anthropic-billing-header: keep this\n'
  const input = freeze(request({
    config: { systemPrompt: 'system prefix' },
    stream: true,
    messages: ['system', 'developer', 'user', 'assistant'].map(role => ({ role, content: text, meta: { name: `${role}-name` } })),
  }))
  assert.deepEqual(toChatRequest(input, 'cursor'), {
    model: 'model',
    stream: true,
    messages: [{ role: 'system', content: 'system prefix' }, ...input.messages.map(({ role, content, meta }) => ({ role, content, name: meta.name }))],
  })
})

test('request converts function tools, named choice and supported reasoning controls', () => {
  const converted = toChatRequest(freeze(request({
    tools: [tool], toolChoice: { name: 'lookup' },
    config: { outputFormat: { type: 'text' }, thinking: { enabled: true, effort: 'high' }, reasoningEffort: 'high' },
  })), 'cursor')
  assert.deepEqual(converted.tools, [{ type: 'function', function: tool }])
  assert.deepEqual(converted.tool_choice, { type: 'function', function: { name: 'lookup' } })
  assert.equal(converted.reasoning_effort, 'high')
  assert.equal(converted.stream, false)
  for (const toolChoice of ['none', 'auto', 'required']) {
    assert.equal(toChatRequest(request({ tools: [tool], toolChoice }), 'cursor').tool_choice, toolChoice)
  }
  assert.equal(toChatRequest(request({ config: { thinking: { enabled: false } } }), 'cursor').reasoning_effort, 'none')
  for (const reasoningEffort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
    assert.equal(toChatRequest(request({ config: { reasoningEffort } }), 'cursor').reasoning_effort, reasoningEffort)
  }
})

test('request preserves assistant tool history from metadata and content blocks without duplication', () => {
  const input = request({ messages: [
    { role: 'assistant', content: [
      { type: 'text', text: 'Looking ' },
      { type: 'tool_use', toolUse: toolCall },
      { type: 'text', text: 'now.' },
    ], meta: { name: 'agent', toolCalls: [toolCall, { id: 'call-2', name: 'other', input: {} }] } },
    { role: 'tool', content: 'result', meta: { toolCallId: 'call-1', name: 'lookup' } },
  ] })
  assert.deepEqual(toChatRequest(freeze(input), 'cursor').messages, [
    { role: 'assistant', content: 'Looking now.', name: 'agent', tool_calls: [wireToolCall, { id: 'call-2', type: 'function', function: { name: 'other', arguments: '{}' } }] },
    { role: 'tool', content: 'result', name: 'lookup', tool_call_id: 'call-1' },
  ])
})

test('identical tool arguments with different object key order are not conflicts', () => {
  const input = request({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', toolUse: { ...toolCall, input: { second: 2, first: 1 } } }],
    meta: { toolCalls: [{ ...toolCall, input: { first: 1, second: 2 } }] } }] })
  assert.equal(toChatRequest(input, 'cursor').messages[0].tool_calls.length, 1)
})

test('request preserves user tool-result blocks and adjacent text in order', () => {
  const input = request({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'before ' }, { type: 'text', text: 'results' },
    { type: 'tool_result', toolResult: { toolUseId: 'call-1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } },
    { type: 'tool_result', toolResult: { toolUseId: 'call-2', content: 'second', isError: false } },
    { type: 'text', text: 'after' },
  ] }] })
  assert.deepEqual(toChatRequest(input, 'cursor').messages, [
    { role: 'user', content: 'before results' },
    { role: 'tool', tool_call_id: 'call-1', content: 'ab' },
    { role: 'tool', tool_call_id: 'call-2', content: 'second' },
    { role: 'user', content: 'after' },
  ])
})

test('tool role accepts result blocks, checks matching metadata and preserves empty text', () => {
  const result = { type: 'tool_result', toolResult: { toolUseId: 'call-1', content: '' } }
  const input = request({ messages: [{ role: 'tool', content: [result], meta: { toolCallId: 'call-1', name: 'lookup' } }] })
  assert.deepEqual(toChatRequest(input, 'cursor').messages, [{ role: 'tool', tool_call_id: 'call-1', content: '', name: 'lookup' }])
  assert.deepEqual(toChatRequest(request({ messages: [{ role: 'user', content: [] }] }), 'cursor').messages, [{ role: 'user', content: '' }])
})

test('unsupported configuration is explicitly rejected even when false or zero', () => {
  for (const [key, value] of Object.entries({
    maxTokens: 1, temperature: 0, topP: 1, stop: [], logprobs: false, topLogprobs: 0,
    thinkingConfig: {}, reasoningSummary: 'auto', extra: 1,
  })) assert.throws(() => toChatRequest(request({ config: { [key]: value } }), 'cursor'), new RegExp(`config\\.${key}.*unsupported`))
  for (const config of [
    { outputFormat: { type: 'json_object' } },
    { outputFormat: { type: 'json_schema', schema: {} } },
    { thinking: { mode: 'adaptive' } },
    { thinking: { budgetTokens: 100 } },
    { thinking: { summary: 'auto' } },
    { thinking: { includeSummary: false } },
    { thinking: { enabled: true } },
    { thinking: { enabled: true, effort: 'none' } },
    { thinking: { enabled: false, effort: 'high' } },
    { thinking: { enabled: 'yes' } },
    { thinking: { effort: 'high' }, reasoningEffort: 'low' },
    { reasoningEffort: 'unknown' },
    { thinking: null },
  ]) assert.throws(() => toChatRequest(request({ config }), 'cursor'), TypeError)
})

test('unsupported content, extra metadata and wrong roles fail rather than disappearing', () => {
  const messages = [
    { role: 'user', content: [{ type: 'image', imageUrl: 'https://example.invalid/image' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'old reasoning' }] },
    { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] },
    { role: 'user', content: [{ type: 'text', text: 'x', signature: 'opaque' }] },
    { role: 'function', content: 'old function role' },
    { role: 'tool', content: 'missing ID' },
    { role: 'user', content: 'text', meta: { toolCalls: [] } },
    { role: 'user', content: 'text', meta: { toolCallId: 'call-1' } },
    { role: 'user', content: 'text', meta: { unsupported: 'value' } },
    { role: 'user', content: [{ type: 'tool_use', toolUse: toolCall }] },
    { role: 'assistant', content: [{ type: 'tool_result', toolResult: { toolUseId: 'call-1', content: 'result' } }] },
    { role: 'user', content: null },
    { role: 'user', content: new Array(1) },
    { role: 'assistant', content: '', meta: { toolCalls: null } },
    { role: 'assistant', content: '', meta: { toolCalls: new Array(1) } },
  ]
  for (const message of messages) assert.throws(() => toChatRequest(request({ messages: [message] }), 'cursor'), TypeError)
})

test('ambiguous or unrepresentable tool histories are rejected', () => {
  const result = { type: 'tool_result', toolResult: { toolUseId: 'call-1', content: 'result' } }
  const messages = [
    { role: 'assistant', content: '', meta: { toolCalls: [toolCall, toolCall] } },
    { role: 'assistant', content: [{ type: 'tool_use', toolUse: toolCall }, { type: 'tool_use', toolUse: toolCall }] },
    { role: 'assistant', content: [{ type: 'tool_use', toolUse: toolCall }], meta: { toolCalls: [{ ...toolCall, input: {} }] } },
    { role: 'assistant', content: '', meta: { toolCalls: [{ ...toolCall, thoughtSignature: 'opaque' }] } },
    { role: 'tool', content: [result, { type: 'text', text: 'ambiguous' }] },
    { role: 'tool', content: [result], meta: { toolCallId: 'wrong-call' } },
    { role: 'tool', content: [result, result], meta: { toolCallId: 'call-1' } },
    { role: 'user', content: [{ ...result, toolResult: { ...result.toolResult, isError: true } }] },
    { role: 'user', content: [{ ...result, toolResult: { ...result.toolResult, content: [{ type: 'image', imageBase64: 'x' }] } }] },
  ]
  for (const message of messages) assert.throws(() => toChatRequest(request({ messages: [message] }), 'cursor'), TypeError)
})

test('JSON inputs are validated instead of stringify silently dropping invalid values', () => {
  const cyclic = {}; cyclic.self = cyclic
  for (const input of [null, [], 'text', { bad: undefined }, { bad: NaN }, { bad: Infinity }, { bad: 1n }, { bad() {} }, cyclic, new Date()]) {
    assert.throws(() => toChatRequest(request({ messages: [{ role: 'assistant', content: '', meta: { toolCalls: [{ ...toolCall, input }] } }] }), 'cursor'), TypeError)
  }
})

test('malformed request, tool definitions and tool choice fail at the codec boundary', () => {
  for (const input of [
    null, [], request({ config: undefined }), request({ messages: [] }), request({ messages: 'text' }),
    request({ stream: 'true' }), request({ unknown: 1 }), request({ tools: null }),
    request({ messages: new Array(1) }), request({ tools: new Array(1) }),
    request({ tools: [tool, tool] }), request({ tools: [{ ...tool, parameters: [] }] }),
    request({ tools: [{ ...tool, description: undefined }] }),
    request({ toolChoice: 'required' }), request({ toolChoice: 'unsupported' }),
    request({ tools: [tool], toolChoice: { name: 'missing' } }),
  ]) assert.throws(() => toChatRequest(input, 'cursor'), TypeError)
})

test('response preserves text, raw reasoning and parsed tool calls with unknown usage', () => {
  const input = freeze(response({ role: 'assistant', content: 'answer', reasoning_content: 'reasoning', tool_calls: [wireToolCall] }, {
    choices: [{ index: 0, message: { role: 'assistant', content: 'answer', reasoning_content: 'reasoning', tool_calls: [wireToolCall] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340, prompt_tokens_details: { cached_tokens: 200 } },
  }))
  assert.deepEqual(fromChatResponse(input), {
    content: [{ type: 'thinking', thinking: 'reasoning', reasoningKind: 'raw' }, { type: 'text', text: 'answer' }],
    finishReason: 'tool_calls', toolCalls: [toolCall], usage: unknownUsage,
  })
})

test('text-only, empty and tool-only responses do not fabricate content or usage', () => {
  assert.deepEqual(fromChatResponse(response()), { content: [{ type: 'text', text: 'hello' }], finishReason: 'stop', usage: unknownUsage })
  assert.deepEqual(fromChatResponse(response({ role: 'assistant', content: '' })).content, [{ type: 'text', text: '' }])
  const converted = fromChatResponse({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [wireToolCall] }, finish_reason: 'tool_calls' }] })
  assert.equal(converted.content, '')
  assert.deepEqual(converted.toolCalls, [toolCall])
  assert.deepEqual(converted.usage, unknownUsage)
})

test('response finish reasons are validated instead of silently mapped to success', () => {
  for (const [finish_reason, expected] of [['stop', 'stop'], ['length', 'length'], ['content_filter', 'error'], ['error', 'error']]) {
    assert.equal(fromChatResponse({ choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason }] }).finishReason, expected)
  }
  for (const finish_reason of [null, undefined, 'unknown', 'tool_calls']) {
    assert.throws(() => fromChatResponse({ choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason }] }), TypeError)
  }
})

test('malformed response tool arguments throw and never become an empty object', () => {
  for (const argumentsText of ['{broken', '', 'null', '[]', '"text"', '12', '{"n":1e999}', {}]) {
    assert.throws(() => fromChatResponse(response({ role: 'assistant', content: null, tool_calls: [{ ...wireToolCall, function: { name: 'lookup', arguments: argumentsText } }] })), TypeError)
  }
  const converted = fromChatResponse(response({ role: 'assistant', content: null, tool_calls: [{ ...wireToolCall, function: { name: 'lookup', arguments: '{}' } }] }))
  assert.deepEqual(converted.toolCalls[0].input, {})
})

test('upstream errors and refusals surface in both response and streaming codecs', () => {
  for (const decode of [fromChatResponse, fromChatChunk]) {
    assert.throws(() => decode({ error: { message: 'CLI exited', code: 'cursor_cli_error' } }), /CLI exited/)
    assert.throws(() => decode({ error: 'permission denied' }), /permission denied/)
    assert.throws(() => decode({ error: {} }), /unspecified upstream error/)
  }
  assert.throws(() => fromChatResponse(response({ role: 'assistant', content: null, refusal: 'declined' })), /declined/)
  assert.throws(() => fromChatChunk(chunk({ refusal: 'declined' })), /declined/)
})

test('malformed response envelopes are rejected, including unsupported extra output', () => {
  for (const input of [
    null, [], {}, { choices: [] }, { choices: [{}, {}] },
    response({ role: 'user', content: 'not assistant' }),
    response({ role: 'assistant', content: [] }),
    response({ role: 'assistant' }),
    response({ role: 'assistant', content: 'text', audio: {} }),
    response({ role: 'assistant', content: null, tool_calls: new Array(1) }),
    response({ role: 'assistant', content: null, tool_calls: [wireToolCall, wireToolCall] }),
    response({ role: 'assistant', content: null, tool_calls: [{ ...wireToolCall, type: 'other' }] }),
    { choices: [{ index: 1, message: { role: 'assistant', content: 'text' }, finish_reason: 'stop' }] },
    { choices: [{ message: { role: 'assistant', content: 'text' }, logprobs: {}, finish_reason: 'stop' }] },
  ]) assert.throws(() => fromChatResponse(input), TypeError)
})

test('a mixed stream frame yields reasoning, text, every tool and a terminal frame in order', () => {
  const input = freeze(chunk({
    role: 'assistant', reasoning_content: 'why', content: 'answer',
    tool_calls: [
      { index: 0, ...wireToolCall },
      { index: 1, id: 'call-2', type: 'function', function: { name: 'other', arguments: '{' } },
    ],
  }, 'tool_calls', { usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } }))
  assert.deepEqual(fromChatChunk(input), [
    { type: 'thinking', delta: 'why', reasoningKind: 'raw' },
    { type: 'content', delta: 'answer' },
    { type: 'tool_call', toolCall: { index: 0, id: 'call-1', name: 'lookup', inputDelta: '{"query":"维拉"}' } },
    { type: 'tool_call', toolCall: { index: 1, id: 'call-2', name: 'other', inputDelta: '{' } },
    { type: 'done', finishReason: 'tool_calls', usage: unknownUsage },
  ])
})

test('tool argument fragments remain exact strings for the streaming caller to assemble', () => {
  const fragments = ['{"query":', '"维', '拉"}']
  const converted = fragments.flatMap(argumentsText => fromChatChunk(chunk({ tool_calls: [{ index: 0, function: { arguments: argumentsText } }] })))
  assert.equal(converted.map(item => item.toolCall.inputDelta).join(''), '{"query":"维拉"}')
  assert.deepEqual(fromChatChunk(chunk({ tool_calls: [{ index: 0, id: 'call-1' }] })), [{ type: 'tool_call', toolCall: { index: 0, id: 'call-1' } }])
})

test('role-only/empty chunks produce arrays, and terminal and usage-only frames report unknown usage', () => {
  assert.deepEqual(fromChatChunk(chunk({ role: 'assistant' })), [])
  assert.deepEqual(fromChatChunk(chunk()), [])
  assert.deepEqual(fromChatChunk(chunk({ content: '' })), [{ type: 'content', delta: '' }])
  assert.deepEqual(fromChatChunk(chunk({}, 'stop')), [{ type: 'done', finishReason: 'stop', usage: unknownUsage }])
  assert.deepEqual(fromChatChunk({ choices: [], usage: { prompt_tokens: 999, completion_tokens: 999 } }), [{ type: 'done', usage: unknownUsage }])
  assert.deepEqual(fromChatChunk(chunk({}, 'content_filter')), [{ type: 'done', finishReason: 'error', usage: unknownUsage }])
  assert.throws(() => fromChatChunk('[DONE]'), TypeError)
})

test('malformed stream frames and unsupported deltas fail explicitly', () => {
  for (const input of [
    null, {}, { choices: [] }, { choices: [{}, {}] },
    chunk(null), chunk({ content: 3 }), chunk({ reasoning_content: {} }),
    chunk({ role: 'user' }), chunk({ audio: {} }), chunk({}, 'unknown'),
    chunk({ tool_calls: {} }), chunk({ tool_calls: new Array(1) }),
    chunk({ tool_calls: [{ function: { arguments: '{}' } }] }),
    chunk({ tool_calls: [{ index: -1, function: { arguments: '{}' } }] }),
    chunk({ tool_calls: [{ index: 0.5, function: { arguments: '{}' } }] }),
    chunk({ tool_calls: [{ index: 0, type: 'custom', function: { arguments: '{}' } }] }),
    chunk({ tool_calls: [{ index: 0 }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: {} } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: '' } }] }),
    chunk({}, null, { usage: { prompt_tokens: 2 } }),
    { choices: [{ index: 1, delta: {} }] },
  ]) assert.throws(() => fromChatChunk(input), TypeError)
})

test('usage shape is checked even though heuristic values are deliberately discarded', () => {
  for (const usage of [[], 'usage', { prompt_tokens: -1 }, { completion_tokens: 1.5 }, { total_tokens: '100' }, { prompt_tokens: Infinity }]) {
    assert.throws(() => fromChatResponse(response(undefined, { usage })), TypeError)
    assert.throws(() => fromChatChunk(chunk({}, 'stop', { usage })), TypeError)
  }
})
