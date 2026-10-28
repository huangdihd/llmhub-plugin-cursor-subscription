import { ProviderAccounts, connectionSchema } from './lib/providers.mjs'
import { toChatRequest, fromChatResponse, fromChatChunk } from './lib/codec.mjs'

function modelInfo(providerName, model, toolsEnabled) {
  return {
    id: `${providerName}/${model.id}`,
    provider: providerName,
    name: model.id,
    display_name: model.display_name || model.name || model.id,
    capabilities: { streaming: true, tools: toolsEnabled, vision: false },
  }
}

export default {
  setup(api) {
    const accounts = new ProviderAccounts(api.config)
    api.onConfigChange((configuration) => accounts.configure(configuration))

    async function fetchModels(provider) {
      const account = accounts.bind(provider, { discovery: true })
      const current = await account.bridge()
      const response = await current.requestJSON('/v1/models', provider.name)
      if (!Array.isArray(response.data) || response.data.some((model) => typeof model.id !== 'string' || !model.id)) {
        throw new Error('Cursor returned an invalid model catalog')
      }
      const models = response.data.map((model) => modelInfo(provider.name, model, account.toolsEnabled))
      account.saveModels(models)
      return models
    }

    api.registerProvider({
      id: 'cursor',
      displayName: 'Cursor Subscription',
      connectionSchema,
      secretConnectionFields: ['extra.cursor_api_key'],
      fetchModels,
      createAdapter(provider) {
        const account = accounts.bind(provider)
        return {
          name: provider.name,
          toProviderRequest(request) {
            account.assertCurrent()
            const converted = toChatRequest(request, provider.name)
            if (!converted.model || converted.model.trim() === 'default') {
              throw new Error('Choose an explicit Cursor model; shared last-request model fallback is disabled')
            }
            if (converted.model !== converted.model.trim() || converted.model.includes('/')) {
              throw new Error('Cursor model IDs must be unqualified catalog IDs without whitespace or slashes')
            }
            const usesTools = converted.tools?.length || converted.messages.some((message) =>
              message.role === 'tool' || message.tool_calls?.length)
            if (usesTools && !account.toolsEnabled) {
              throw new Error('Cursor tool support is experimental; enable enable_tools after verifying CLI ACP compatibility')
            }
            return converted
          },
          async call(request) {
            return (await account.bridge()).requestJSON('/v1/chat/completions', provider.name,
              { ...request, stream: false })
          },
          async callStream(request) {
            return (await account.bridge()).requestStream(provider.name, request)
          },
          fromProviderResponse: fromChatResponse,
          fromProviderStreamChunk: fromChatChunk,
          async embed() {
            throw new Error('Cursor subscriptions do not support embeddings through this plugin')
          },
          getModels() {
            account.assertCurrent()
            if (provider.use_custom_models) {
              return (provider.models ?? []).map((model) => modelInfo(provider.name, model, account.toolsEnabled))
            }
            return account.models()
          },
        }
      },
    })

    // LLMHub allows only ~1s for plugin cleanup. Initiate graceful child shutdown
    // synchronously; the child owns its bounded drain and parent-disconnect hook.
    return () => { void accounts.close() }
  },
}
