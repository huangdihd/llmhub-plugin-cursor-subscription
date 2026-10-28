import { createHash } from 'node:crypto'
import { CursorBridge, parseConfiguration } from './bridge.mjs'

export const connectionSchema = [
  { key: 'auth_mode', label: 'Account authentication', type: 'select', default: 'api_key',
    options: [{ label: 'This account’s Cursor API key', value: 'api_key' },
      { label: 'Server CLI login (one provider only)', value: 'cli_login' }] },
  { key: 'cursor_api_key', label: 'This account’s Cursor API key', type: 'secret' },
  { key: 'enable_tools', label: 'Experimental ACP tool calls', type: 'boolean', default: false },
  { key: 'timeout_seconds', label: 'Request deadline in seconds', type: 'number', default: 180 },
]

function pluginConfiguration(configuration) {
  // Legacy fields must survive host upgrade validation, but never become
  // account defaults. Only the CLI executable is still plugin-global.
  if (configuration.agent_binary !== undefined && typeof configuration.agent_binary !== 'string') {
    throw new Error('agent_binary must be a string')
  }
  return { agent_binary: configuration.agent_binary?.trim() || '' }
}

function accountConfiguration(provider, configuration) {
  if (typeof provider.name !== 'string' || !provider.name.trim()) {
    throw new Error('Cursor provider requires a name')
  }
  const extra = provider.connection?.extra ?? {}
  const account = {
    ...configuration,
    auth_mode: extra.auth_mode ?? 'api_key',
    cursor_api_key: extra.cursor_api_key ?? '',
    enable_tools: extra.enable_tools ?? false,
    timeout_seconds: extra.timeout_seconds ?? 180,
  }
  parseConfiguration(account)
  return account
}

function fingerprint(configuration) {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex')
}

/** Owns one lazy worker and generation-bound catalog per provider record. */
export class ProviderAccounts {
  #configuration
  #records = new Map()
  #closed = false
  #cliShutdown = Promise.resolve()
  #createBridge

  constructor(configuration = {}, createBridge = (account) => new CursorBridge(account)) {
    this.#configuration = pluginConfiguration(configuration)
    this.#createBridge = createBridge
  }

  #stop(record) {
    record.active = false
    const bridge = record.bridge
    record.bridge = undefined
    record.models = []
    record.shutdown = Promise.all([record.shutdown, bridge?.close()])
    if (record.authMode === 'cli_login') {
      this.#cliShutdown = Promise.all([this.#cliShutdown, record.shutdown])
    }
    return record.shutdown
  }

  configure(configuration) {
    const next = pluginConfiguration(configuration)
    if (next.agent_binary === this.#configuration.agent_binary) return
    this.#configuration = next
    for (const record of this.#records.values()) this.#stop(record)
  }

  bind(provider, { discovery = false } = {}) {
    if (this.#closed) throw new Error('Cursor plugin is disabled')
    const configuration = accountConfiguration(provider, this.#configuration)
    const signature = fingerprint(configuration)
    const previous = this.#records.get(provider.name)
    if (previous?.active && previous.signature === signature) return previous.binding
    // Discovery can arrive from a loader snapshot predating credential rotation.
    // Only adapter creation may replace an existing account generation.
    if (discovery && previous) throw new Error('Cursor provider changed; reload adapters before model discovery')
    if (configuration.auth_mode === 'cli_login') {
      for (const [name, record] of this.#records) {
        if (name !== provider.name && record.authMode === 'cli_login') {
          throw new Error('Server CLI login is already bound to another provider; use per-account API keys')
        }
      }
    }
    const previousShutdown = previous ? this.#stop(previous) : Promise.resolve()
    // A different provider may claim CLI login while its former owner drains.
    // Transfer the identity only after every previous CLI worker has exited.
    const shutdown = configuration.auth_mode === 'cli_login'
      ? Promise.all([previousShutdown, this.#cliShutdown]) : previousShutdown
    const record = {
      signature, authMode: configuration.auth_mode, active: true, shutdown,
      bridge: undefined, models: [], binding: undefined,
    }
    const assertCurrent = () => {
      if (this.#closed) throw new Error('Cursor plugin is disabled')
      if (!record.active || this.#records.get(provider.name) !== record) {
        throw new Error('Cursor provider configuration changed; recreate the adapter')
      }
    }
    record.binding = {
      toolsEnabled: configuration.enable_tools,
      assertCurrent,
      bridge: async () => {
        assertCurrent()
        await record.shutdown
        assertCurrent()
        record.bridge ??= this.#createBridge(configuration)
        return record.bridge
      },
      models: () => { assertCurrent(); return record.models },
      saveModels: (models) => { assertCurrent(); record.models = models },
    }
    this.#records.set(provider.name, record)
    return record.binding
  }

  close() {
    this.#closed = true
    return Promise.all([...this.#records.values()].map((record) => this.#stop(record)))
  }
}
