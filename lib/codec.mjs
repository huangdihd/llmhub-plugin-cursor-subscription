import { isDeepStrictEqual } from 'node:util'

// This codec targets cursor-api-proxy 1.7.0, not an unrestricted OpenAI server.
// Its chat handler consumes system text, tools and reasoning_effort, but ignores
// sampling, output limits, stop sequences, structured output and logprobs.
// Images and replayed reasoning are deliberately unsupported here. The proxy
// itself sanitizes text and renders history as a prompt; this codec does neither.
const roles = new Set(['system', 'developer', 'user', 'assistant', 'tool'])
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${path} must be an object`)
  }
  return value
}

function fields(value, allowed, path) {
  record(value, path)
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined && !allowed.includes(key)) {
      throw new TypeError(`${path}.${key} is unsupported by the Cursor bridge`)
    }
  }
}

function string(value, path, nonempty = false) {
  if (typeof value !== 'string' || (nonempty && !value.trim())) {
    throw new TypeError(`${path} must be ${nonempty ? 'a nonempty' : 'a'} string`)
  }
  return value
}

function array(value, path) {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  // Densify sparse arrays so missing entries are validated, never silently skipped.
  return Array.from(value)
}

function jsonValue(value, path, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new TypeError(`${path} must contain only JSON values`)
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (item, index) => jsonValue(item, `${path}[${index}]`, ancestors))
    }
    record(value, path)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, `${path}.${key}`, ancestors)]))
  } finally {
    ancestors.delete(value)
  }
}

function jsonObject(value, path) {
  record(value, path)
  return jsonValue(value, path)
}

function toToolCall(value, path) {
  fields(value, ['id', 'name', 'input'], path)
  return {
    id: string(value.id, `${path}.id`, true),
    type: 'function',
    function: {
      name: string(value.name, `${path}.name`, true),
      arguments: JSON.stringify(jsonObject(value.input, `${path}.input`)),
    },
  }
}

function contentBlocks(content, path) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return array(content, path).map((block, index) => {
    const location = `${path}[${index}]`
    record(block, location)
    const allowed = { text: ['type', 'text'], tool_use: ['type', 'toolUse'], tool_result: ['type', 'toolResult'] }[block.type]
    if (!allowed) throw new TypeError(`${location}.type ${String(block.type)} is unsupported by the Cursor bridge`)
    fields(block, allowed, location)
    if (block.type === 'text') string(block.text, `${location}.text`)
    return block
  })
}

function textContent(content, path) {
  return contentBlocks(content, path).map(block => {
    if (block.type !== 'text') throw new TypeError(`${path} must contain only text`)
    return block.text
  }).join('')
}

function toolResultMessage(block, path, name) {
  const result = block.toolResult
  fields(result, ['toolUseId', 'content', 'isError'], `${path}.toolResult`)
  if (result.isError !== undefined && result.isError !== false) {
    throw new TypeError(`${path}.toolResult.isError is unsupported by Chat Completions`)
  }
  return {
    role: 'tool',
    tool_call_id: string(result.toolUseId, `${path}.toolResult.toolUseId`, true),
    content: textContent(result.content, `${path}.toolResult.content`),
    ...(name === undefined ? {} : { name }),
  }
}

function toMessages(message, index) {
  const path = `messages[${index}]`
  fields(message, ['role', 'content', 'meta'], path)
  if (!roles.has(message.role)) throw new TypeError(`${path}.role is unsupported`)
  const metadata = message.meta === undefined ? {} : message.meta
  fields(metadata, ['name', 'toolCalls', 'toolCallId'], `${path}.meta`)
  const named = metadata.name === undefined ? {} : { name: string(metadata.name, `${path}.meta.name`, true) }
  if (metadata.toolCalls !== undefined && message.role !== 'assistant') {
    throw new TypeError(`${path}.meta.toolCalls requires the assistant role`)
  }
  if (metadata.toolCallId !== undefined && message.role !== 'tool') {
    throw new TypeError(`${path}.meta.toolCallId requires the tool role`)
  }
  const blocks = contentBlocks(message.content, `${path}.content`)

  if (message.role === 'tool') {
    const results = blocks.filter(block => block.type === 'tool_result')
    if (results.length > 0) {
      if (results.length !== blocks.length) throw new TypeError(`${path} cannot mix tool results with other content`)
      const converted = results.map(block => toolResultMessage(block, path, named.name))
      if (metadata.toolCallId !== undefined && (converted.length !== 1 || converted[0].tool_call_id !== metadata.toolCallId)) {
        throw new TypeError(`${path}.meta.toolCallId conflicts with tool result IDs`)
      }
      return converted
    }
    return [{
      role: 'tool',
      content: textContent(message.content, `${path}.content`),
      ...named,
      tool_call_id: string(metadata.toolCallId, `${path}.meta.toolCallId`, true),
    }]
  }

  if (message.role === 'assistant') {
    const calls = new Map()
    const metadataCalls = metadata.toolCalls === undefined ? [] : array(metadata.toolCalls, `${path}.meta.toolCalls`)
    for (const call of metadataCalls) {
      const converted = toToolCall(call, `${path}.meta.toolCalls`)
      if (calls.has(converted.id)) throw new TypeError(`${path} contains duplicate tool call IDs`)
      calls.set(converted.id, converted)
    }
    const blockIds = new Set()
    let content = ''
    for (const block of blocks) {
      if (block.type === 'text') {
        content += block.text
        continue
      }
      if (block.type !== 'tool_use') throw new TypeError(`${path} assistant content cannot contain tool results`)
      const call = toToolCall(block.toolUse, `${path}.content.toolUse`)
      if (blockIds.has(call.id)) throw new TypeError(`${path} contains duplicate tool call IDs`)
      blockIds.add(call.id)
      const previous = calls.get(call.id)
      if (previous && (previous.function.name !== call.function.name
        || !isDeepStrictEqual(JSON.parse(previous.function.arguments), JSON.parse(call.function.arguments)))) {
        throw new TypeError(`${path} contains conflicting tool call ${call.id}`)
      }
      calls.set(call.id, call)
    }
    return [{ role: 'assistant', content, ...named, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) }]
  }

  const converted = []
  let text = ''
  let hasText = false
  const flushText = () => {
    if (!hasText) return
    converted.push({ role: message.role, content: text, ...named })
    text = ''
    hasText = false
  }
  for (const block of blocks) {
    if (block.type === 'text') {
      text += block.text
      hasText = true
      continue
    }
    if (block.type !== 'tool_result' || message.role !== 'user') {
      throw new TypeError(`${path} ${message.role} content cannot contain ${block.type}`)
    }
    flushText()
    converted.push(toolResultMessage(block, path, named.name))
  }
  flushText()
  return converted.length ? converted : [{ role: message.role, content: '', ...named }]
}

function reasoningEffort(configuration) {
  let effort = configuration.reasoningEffort
  if (configuration.thinking !== undefined) {
    const thinking = configuration.thinking
    fields(thinking, ['enabled', 'effort'], 'config.thinking')
    if (thinking.enabled !== undefined && typeof thinking.enabled !== 'boolean') {
      throw new TypeError('config.thinking.enabled must be a boolean')
    }
    const requested = thinking.enabled === false ? 'none' : thinking.effort
    if (thinking.enabled === false && thinking.effort !== undefined && thinking.effort !== 'none') {
      throw new TypeError('config.thinking.enabled conflicts with effort')
    }
    if (thinking.enabled === true && (requested === undefined || requested === 'none')) {
      throw new TypeError('config.thinking.enabled requires an explicit non-none effort')
    }
    if (requested !== undefined && effort !== undefined && requested !== effort) {
      throw new TypeError('config.thinking.effort conflicts with reasoningEffort')
    }
    effort = requested ?? effort
  }
  if (effort !== undefined && !efforts.has(effort)) throw new TypeError('config reasoning effort is unsupported')
  return effort
}

/** Convert portable LLMHub requests without importing gateway implementation code. */
export function toChatRequest(request, providerName) {
  fields(request, ['model', 'messages', 'config', 'tools', 'toolChoice', 'stream'], 'request')
  string(providerName, 'providerName', true)
  const configuration = request.config
  fields(configuration, ['systemPrompt', 'reasoningEffort', 'thinking', 'outputFormat'], 'config')
  if (configuration.outputFormat !== undefined) {
    fields(configuration.outputFormat, ['type'], 'config.outputFormat')
    if (configuration.outputFormat.type !== 'text') throw new TypeError('config.outputFormat supports only text')
  }
  if (request.stream !== undefined && typeof request.stream !== 'boolean') throw new TypeError('request.stream must be a boolean')
  const messages = []
  if (configuration.systemPrompt !== undefined) {
    messages.push({ role: 'system', content: string(configuration.systemPrompt, 'config.systemPrompt') })
  }
  for (const [index, message] of array(request.messages, 'messages').entries()) messages.push(...toMessages(message, index))
  if (!messages.length) throw new TypeError('messages must not be empty')
  const converted = { messages, stream: request.stream ?? false }
  if (request.model !== undefined) {
    const model = string(request.model, 'model', true)
    const prefix = `${providerName}/`
    converted.model = string(model.startsWith(prefix) ? model.slice(prefix.length) : model, 'model', true)
  }
  const effort = reasoningEffort(configuration)
  if (effort !== undefined) converted.reasoning_effort = effort
  const toolNames = new Set()
  if (request.tools !== undefined) {
    converted.tools = array(request.tools, 'tools').map((tool, index) => {
      const path = `tools[${index}]`
      fields(tool, ['name', 'description', 'parameters'], path)
      const name = string(tool.name, `${path}.name`, true)
      if (toolNames.has(name)) throw new TypeError(`Duplicate tool name: ${name}`)
      toolNames.add(name)
      return {
        type: 'function',
        function: {
          name,
          description: string(tool.description, `${path}.description`),
          parameters: jsonObject(tool.parameters, `${path}.parameters`),
        },
      }
    })
  }
  if (request.toolChoice !== undefined) {
    const choice = request.toolChoice
    if (typeof choice === 'string') {
      if (!['auto', 'none', 'required'].includes(choice)) throw new TypeError('toolChoice is unsupported')
      if (choice === 'required' && !toolNames.size) throw new TypeError('toolChoice required needs tools')
      converted.tool_choice = choice
    } else {
      fields(choice, ['name'], 'toolChoice')
      const name = string(choice.name, 'toolChoice.name', true)
      if (!toolNames.has(name)) throw new TypeError('toolChoice names an undeclared tool')
      converted.tool_choice = { type: 'function', function: { name } }
    }
  }
  return converted
}

function checkError(payload) {
  record(payload, 'response')
  if (payload.error === undefined || payload.error === null) return
  const detail = typeof payload.error === 'string' ? payload.error : payload.error.message
  throw new Error(`Cursor bridge error: ${typeof detail === 'string' ? detail : 'unspecified upstream error'}`)
}

function finishReason(value) {
  if (!['stop', 'length', 'tool_calls', 'error', 'content_filter'].includes(value)) {
    throw new TypeError(`Unsupported finish_reason: ${String(value)}`)
  }
  return value === 'content_filter' ? 'error' : value
}

function onlyChoice(payload, usageOnly = false) {
  const choices = array(payload.choices, 'response.choices')
  if (usageOnly && choices.length === 0 && payload.usage != null) return undefined
  if (choices.length !== 1) throw new TypeError('response must contain exactly one choice')
  const choice = record(choices[0], 'response.choices[0]')
  if (choice.index !== undefined && choice.index !== 0) throw new TypeError('Only choice index 0 is supported')
  if (choice.logprobs != null) throw new TypeError('Response logprobs are unsupported by the Cursor bridge')
  return choice
}

function unknownUsage(usage) {
  if (usage != null) {
    record(usage, 'response.usage')
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0)) {
        throw new TypeError(`response.usage.${key} must be a nonnegative integer`)
      }
    }
  }
  // cursor-api-proxy 1.7.0 fabricates usage from round(characters / 4), with
  // minimum 1. These are NOT measured tokens. Portable Usage has no provenance
  // flag, so zero means unknown; never expose these estimates or cache counts.
  return { promptTokens: 0, completionTokens: 0 }
}

function fromToolCall(call, index) {
  const path = `response.tool_calls[${index}]`
  fields(call, ['id', 'type', 'function'], path)
  if (call.type !== 'function') throw new TypeError(`${path}.type must be function`)
  fields(call.function, ['name', 'arguments'], `${path}.function`)
  const argumentsText = string(call.function.arguments, `${path}.function.arguments`)
  let input
  try {
    input = JSON.parse(argumentsText)
  } catch {
    throw new TypeError(`${path}.function.arguments must be valid JSON`)
  }
  return {
    id: string(call.id, `${path}.id`, true),
    name: string(call.function.name, `${path}.function.name`, true),
    input: jsonObject(input, `${path}.function.arguments`),
  }
}

export function fromChatResponse(response) {
  checkError(response)
  const choice = onlyChoice(response)
  const message = choice.message
  fields(message, ['role', 'content', 'reasoning_content', 'tool_calls', 'refusal'], 'response.message')
  if (message.role !== 'assistant') throw new TypeError('response.message.role must be assistant')
  if (message.refusal != null) throw new Error(`Cursor bridge refusal: ${string(message.refusal, 'response.message.refusal')}`)
  const toolCalls = message.tool_calls === undefined ? [] : array(message.tool_calls, 'response.tool_calls').map(fromToolCall)
  if (new Set(toolCalls.map(call => call.id)).size !== toolCalls.length) throw new TypeError('Response contains duplicate tool call IDs')
  const content = []
  if (message.reasoning_content != null) content.push({ type: 'thinking', thinking: string(message.reasoning_content, 'response.reasoning_content'), reasoningKind: 'raw' })
  if (message.content != null) content.push({ type: 'text', text: string(message.content, 'response.content') })
  if (message.content === undefined && !content.length && !toolCalls.length) throw new TypeError('Response message has no content or tool calls')
  const reason = finishReason(choice.finish_reason)
  if (reason === 'tool_calls' && !toolCalls.length) throw new TypeError('tool_calls finish_reason requires tool calls')
  return {
    content: content.length ? content : '',
    finishReason: reason,
    ...(toolCalls.length ? { toolCalls } : {}),
    usage: unknownUsage(response.usage),
  }
}

function fromToolDelta(call, position) {
  const path = `response.delta.tool_calls[${position}]`
  fields(call, ['index', 'id', 'type', 'function'], path)
  if (!Number.isSafeInteger(call.index) || call.index < 0) throw new TypeError(`${path}.index must be a nonnegative integer`)
  if (call.type !== undefined && call.type !== 'function') throw new TypeError(`${path}.type must be function`)
  const converted = { index: call.index }
  if (call.id !== undefined) converted.id = string(call.id, `${path}.id`, true)
  if (call.function !== undefined) {
    fields(call.function, ['name', 'arguments'], `${path}.function`)
    if (call.function.name !== undefined) converted.name = string(call.function.name, `${path}.function.name`, true)
    // Stream arguments are JSON fragments, not complete JSON documents. The
    // caller must assemble/validate them before execution; never replace with {}.
    if (call.function.arguments !== undefined) converted.inputDelta = string(call.function.arguments, `${path}.function.arguments`)
  }
  if (Object.keys(converted).length === 1) throw new TypeError(`${path} contains no tool call delta`)
  return { type: 'tool_call', toolCall: converted }
}

/** Decode one parsed SSE JSON payload. The transport owns the [DONE] sentinel. */
export function fromChatChunk(chunk) {
  checkError(chunk)
  const choice = onlyChoice(chunk, true)
  const usage = unknownUsage(chunk.usage)
  if (!choice) return [{ type: 'done', usage }]
  const delta = choice.delta
  fields(delta, ['role', 'content', 'reasoning_content', 'tool_calls', 'refusal'], 'response.delta')
  if (delta.role !== undefined && delta.role !== 'assistant') throw new TypeError('response.delta.role must be assistant')
  if (delta.refusal != null) throw new Error(`Cursor bridge refusal: ${string(delta.refusal, 'response.delta.refusal')}`)
  const chunks = []
  if (delta.reasoning_content != null) chunks.push({ type: 'thinking', delta: string(delta.reasoning_content, 'response.delta.reasoning_content'), reasoningKind: 'raw' })
  if (delta.content != null) chunks.push({ type: 'content', delta: string(delta.content, 'response.delta.content') })
  if (delta.tool_calls !== undefined) chunks.push(...array(delta.tool_calls, 'response.delta.tool_calls').map(fromToolDelta))
  if (choice.finish_reason != null) chunks.push({ type: 'done', finishReason: finishReason(choice.finish_reason), usage })
  else if (chunk.usage != null) throw new TypeError('response.usage requires a terminal or usage-only chunk')
  return chunks
}
