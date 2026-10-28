/**
 * Upstream 1.7.0 renders only message.content in fresh prompts. Retain tool
 * call/result associations there as well, without removing the structured
 * fields used to resume live ACP calls. This is transcript text, not new tools.
 */
export function preserveToolHistory(messages) {
  if (!Array.isArray(messages)) throw new Error('messages must be an array')
  let lastCalls = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== 'assistant') continue
    if (messages[index].tool_calls?.length) lastCalls = index
    break
  }
  if (lastCalls !== -1 && messages.slice(lastCalls + 1).some((message) => message.role === 'tool')
    && messages.at(-1)?.role !== 'tool') {
    throw new Error('A live tool continuation must end with its tool results; send new user text after the assistant completes')
  }

  // Current result bodies must remain byte-exact for session.resume(). Only
  // earlier completed results need a transcript label for a fresh CLI turn.
  let trailingResults = messages.length
  while (trailingResults > 0 && messages[trailingResults - 1].role === 'tool') trailingResults--
  const currentIds = messages.slice(trailingResults).map((message) => message.tool_call_id)
  if (new Set(currentIds).size !== currentIds.length) {
    throw new Error('A tool continuation cannot contain duplicate result IDs')
  }
  return messages.map((message, index) => {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      return { ...message, content: `${message.content ?? ''}\n[Assistant tool calls: ${JSON.stringify(message.tool_calls)}]` }
    }
    if (message.role === 'tool' && index < trailingResults) {
      return { ...message, content: `[Tool result for ${JSON.stringify(message.tool_call_id)}]\n${message.content ?? ''}` }
    }
    return message
  })
}
