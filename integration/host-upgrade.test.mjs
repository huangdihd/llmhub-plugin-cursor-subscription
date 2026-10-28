import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Compile the real LLMHub runtime first; no host configuration or credentials
// are read. The npm installer is a local fixture, not a registry operation.
const build = process.env.LLMHUB_BUILD
if (!build) throw new Error('Set LLMHUB_BUILD to the compiled LLMHub server directory; see README')
const require = createRequire(import.meta.url)
const { PluginManager } = require(`${build}/plugins-runtime/manager.js`)
const { validateConfiguration } = require(`${build}/plugins-runtime/manifest.js`)
const { ProviderRegistry } = require(`${build}/core/registry.js`)
const { HookRegistry } = require(`${build}/core/hooks.js`)
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const legacySchema = [
  { key: 'agent_binary', type: 'text', default: '' },
  { key: 'cursor_api_key', type: 'secret' },
  { key: 'bridge_port', type: 'number', default: 0 },
  { key: 'enable_tools', type: 'boolean', default: false },
  { key: 'timeout_seconds', type: 'number', default: 180 },
]

for (const scenario of [
  { name: '0.1.0 with saved defaults', version: '0.1.0', schema: legacySchema, configuration: {} },
  { name: '0.1.0 with a saved secret and nondefault settings', version: '0.1.0', schema: legacySchema,
    configuration: { cursor_api_key: 'fixture-secret', bridge_port: 1234, enable_tools: true, timeout_seconds: 60 } },
  { name: '0.2.0 with executable only', version: '0.2.0', schema: legacySchema.slice(0, 1),
    configuration: { agent_binary: '/fixture/agent' } },
]) {
  test(`real host upgrades ${scenario.name} without clearing configuration`, async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'cursor-host-upgrade-'))
    const values = new Map()
    const providerRegistry = new ProviderRegistry()
    let replacement = false
    const manager = new PluginManager({ directory, providerRegistry, hookRegistry: new HookRegistry(),
      storage: {
        async getItem(key) { return structuredClone(values.get(key) ?? null) },
        async setItem(key, value) { values.set(key, structuredClone(value)) },
        async removeItem(key) { values.delete(key) },
        async getKeys(prefix) { return [...values.keys()].filter(key => key.startsWith(prefix)) },
      },
      npmRunner: async (argumentsList, target) => {
        const destination = join(target, 'node_modules', manifest.name)
        await mkdir(destination, { recursive: true })
        const packageManifest = replacement ? manifest : { ...manifest, version: scenario.version,
          llmhub: { ...manifest.llmhub, configSchema: scenario.schema } }
        await writeFile(join(destination, 'package.json'), JSON.stringify(packageManifest))
        if (!replacement) {
          await writeFile(join(destination, 'index.mjs'), 'export default { setup() {} }')
          return
        }
        await cp(new URL('../index.mjs', import.meta.url), join(destination, 'index.mjs'))
        await cp(new URL('../lib/', import.meta.url), join(destination, 'lib'), { recursive: true })
      },
    })
    try {
      await manager.installNpm({ name: manifest.name })
      await manager.updateConfig('cursor-subscription', scenario.configuration)
      await manager.enable('cursor-subscription')
      const stateKey = 'runtime-plugins:cursor-subscription:state'
      const previous = structuredClone(values.get(stateKey).configuration)
      if (scenario.version === '0.1.0') {
        // This is the exact pre-activation failure in published 0.2.0.
        assert.throws(() => validateConfiguration(legacySchema.slice(0, 1), previous, {}, false),
          /Unknown configuration field/)
      }
      replacement = true
      await manager.update('cursor-subscription')
      const record = manager.list().find(candidate => candidate.id === 'cursor-subscription')
      assert.equal(record.manifest.version, manifest.version)
      assert.equal(record.enabled, true)
      const saved = values.get(stateKey).configuration
      for (const [key, value] of Object.entries(previous)) assert.equal(saved[key], value)
      assert.equal(manager.getConfig('cursor-subscription').cursor_api_key, undefined)
      const definition = providerRegistry.get('cursor-subscription:cursor')
      assert.ok(definition)
      assert.throws(() => definition.createAdapter({ name: 'unmigrated' }), /requires its own cursor_api_key/)
      const adapter = definition.createAdapter({ name: 'migrated', connection: { extra: {
        auth_mode: 'cli_login',
      } }, use_custom_models: true, models: [{ id: 'composer-2.5' }] })
      assert.equal(adapter.getModels()[0].capabilities.tools, false)
    } finally {
      await manager.shutdown()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
