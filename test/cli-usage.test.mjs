import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter, getEventListeners, once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseCLIUsage, readCLIUsage } from '../lib/cli-usage.mjs'

const startup = 'Cursor Agent\n→ Plan, search, build anything\n'
const suggestion = '\n❯ /usage Show plan and on-demand usage\n'
const panel = `Usage • Premium     Resets Nov 2
Monthly plan and on-demand usage
Category Current Usage
Included 23% used
Auto 23% used
API 0% used
On-Demand $0
No monthly limit
View in dashboard: cursor.com/dashboard?tab=usage
Esc to close
`
const expected = { plan: 'Premium', used_percent: 23, reset_label: 'Resets Nov 2' }

function fixture(options = {}) {
  const child = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdout = new EventEmitter()
  const writes = []
  const signals = []
  child.stdin.write = (value) => { writes.push(value); return true }
  child.kill = (signal) => { signals.push(signal); return true }
  let invocation
  const result = readCLIUsage('/fixture/agent', {
    directory: '/fixture/empty-workspace', timeoutMilliseconds: 1000, ...options,
    launch(executable, argumentsList, configuration) {
      invocation = { executable, argumentsList, configuration }
      return child
    },
  })
  return { child, writes, signals, invocation, result,
    output(value) { child.stdout.emit('data', Buffer.from(value)) },
    open() { this.output(startup); this.output(suggestion) },
    close() { child.emit('close', 0) },
  }
}

// No inference CLI is run: these streams model the verified interactive UI.
test('only the registered interactive usage command receives Enter', async () => {
  const controller = new AbortController()
  const current = fixture({ signal: controller.signal })
  assert.equal(current.invocation.executable, 'python3')
  assert.equal(path.basename(current.invocation.argumentsList[1]), 'terminal.py')
  assert.deepEqual(current.invocation.argumentsList.slice(2), ['/fixture/agent'])
  assert.equal(current.invocation.configuration.cwd, '/fixture/empty-workspace')
  assert.equal(current.invocation.configuration.detached, true)
  assert.deepEqual(current.invocation.configuration.stdio, ['pipe', 'pipe', 'ignore'])
  assert.deepEqual(current.writes, [])
  current.output('Cursor Agent\n')
  assert.deepEqual(current.writes, [])
  current.output('→ Plan, search, build anything\n')
  assert.deepEqual(current.writes, ['/usage'])
  current.output('/usage\n/usage Unknown command\n')
  assert.deepEqual(current.writes, ['/usage'])
  current.output(suggestion)
  assert.deepEqual(current.writes, ['/usage', '\r'])
  current.output(`user@example.invalid\nTOKEN_SECRET_SENTINEL\n${panel}`)
  assert.deepEqual(await current.result, expected)
  assert.deepEqual(current.signals, ['SIGTERM'])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  current.close()
  current.output(panel)
  current.child.emit('error', new Error('LATE_SECRET'))
  controller.abort(new Error('SECRET'))
  assert.deepEqual(current.writes, ['/usage', '\r'])
})

test('temporary workspace trust uses a once, without Enter', async () => {
  const current = fixture()
  current.output('Workspace Trust Required')
  assert.deepEqual(current.writes, ['a'])
  current.output('Workspace Trust Required\n')
  assert.deepEqual(current.writes, ['a'])
  current.output(startup)
  current.output(suggestion)
  current.output(panel)
  assert.deepEqual(await current.result, expected)
  assert.deepEqual(current.writes, ['a', '/usage', '\r'])
  current.close()

  const ready = fixture()
  ready.output('Workspace Trust Required')
  ready.output(startup)
  ready.output(suggestion)
  ready.output(panel)
  assert.deepEqual(await ready.result, expected)
  assert.deepEqual(ready.writes, ['a', '/usage', '\r'])
  ready.close()
})

test('byte-split UTF-8 and ANSI sequences preserve startup, suggestion and usage parsing', async () => {
  const current = fixture()
  for (const value of [startup, suggestion, panel]) {
    const styled = `\x1b[2K\x1b[32m${value}\x1b[0m`
    for (const byte of Buffer.from(styled)) current.output([byte])
  }
  assert.deepEqual(await current.result, expected)
  assert.deepEqual(current.writes, ['/usage', '\r'])
  current.close()
})

test('a suggestion before startup cannot authorize a later prompt submission', async () => {
  const current = fixture({ timeoutMilliseconds: 20 })
  current.output(suggestion + startup)
  current.output('/usage\n')
  await assert.rejects(current.result, /timed out/)
  assert.deepEqual(current.writes, ['/usage'])
  current.close()
})

test('unknown commands, partial suggestions, and lookalikes never receive Enter', async () => {
  for (const value of ['/usage', '/usage Show plan', '/usage Show plan and on-demand usage extra\n',
    '/usage-something Show plan and on-demand usage\n', 'say /usage Show plan and on-demand usage\n']) {
    const current = fixture({ timeoutMilliseconds: 15 })
    current.output(startup)
    current.output(value)
    await assert.rejects(current.result, /timed out/)
    assert.deepEqual(current.writes, ['/usage'])
    assert.deepEqual(current.signals, ['SIGTERM'])
    current.close()
  }
})

test('parser returns only current plan, included percentage and literal reset label', () => {
  assert.deepEqual(parseCLIUsage(`email@example.invalid\n\x1b[32m${panel}\x1b[0m`), expected)
  assert.deepEqual(parseCLIUsage(panel.replace('     Resets Nov 2', '')), { plan: 'Premium', used_percent: 23 })
  assert.deepEqual(parseCLIUsage(panel.replace('23% used', '0% used')), { ...expected, used_percent: 0 })
  assert.deepEqual(parseCLIUsage(panel.replace('23% used', '100% used')), { ...expected, used_percent: 100 })
  assert.deepEqual(parseCLIUsage(panel.replace('23% used', '23.5% used')), { ...expected, used_percent: 23.5 })
  assert.deepEqual(parseCLIUsage(panel + panel.replace('23% used', '42% used')), { ...expected, used_percent: 42 })
  assert.deepEqual(parseCLIUsage(panel.replace(/\n/g, '\r\n')), expected)
  assert.deepEqual(parseCLIUsage(panel.replace('Included 23% used', 'Included 23% used ███░░░')
    .replace('Category Current Usage', 'Category   Current   Usage')), expected)
})

test('malformed panels never substitute Auto/API values or invent usage', () => {
  for (const value of ['', panel.replace('Included 23% used\n', ''),
    panel.replace('Included 23% used', 'Included 101% used'),
    panel.replace('Included 23% used', 'Included -1% used'),
    panel.replace('Included 23% used', 'Included NaN% used'),
    panel.replace('Included 23% used', 'Included 23% used\nIncluded 24% used'),
    panel.replace('Monthly plan and on-demand usage', ''),
    panel.replace('Category Current Usage', ''), panel.replace('Esc to close', ''),
    panel.replace('Premium', 'person@example.invalid'),
    panel.replace('Nov 2', 'sensitive unexpected value')]) {
    assert.throws(() => parseCLIUsage(value), { message: 'Cursor CLI returned an unsupported usage panel' })
  }
})

test('complete but unparseable panel fails safely and terminates transport', async () => {
  const current = fixture()
  current.open()
  current.output(panel.replace('Included 23% used', 'SECRET_SENTINEL'))
  await assert.rejects(current.result, { message: 'Cursor CLI returned an unsupported usage panel' })
  assert.deepEqual(current.signals, ['SIGTERM'])
  current.close()
})

test('deadline covers the usage panel, not only startup', async () => {
  const current = fixture({ timeoutMilliseconds: 15 })
  current.open()
  current.output(panel.replace('Esc to close', ''))
  await assert.rejects(current.result, /timed out/)
  assert.deepEqual(current.signals, ['SIGTERM'])
  current.close()
})

test('cancellation is redacted and listeners are removed', async () => {
  const controller = new AbortController()
  const current = fixture({ signal: controller.signal })
  current.open()
  controller.abort(new Error('SECRET_SENTINEL'))
  await assert.rejects(current.result, { message: 'Cursor CLI usage query cancelled' })
  assert.deepEqual(current.signals, ['SIGTERM'])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  current.close()
  let launched = false
  await assert.rejects(readCLIUsage('/fixture/agent', { signal: controller.signal,
    launch() { launched = true } }), { message: 'Cursor CLI usage query cancelled' })
  assert.equal(launched, false)
})

test('transport failures never expose spawn, stream, exit or abort details', async () => {
  await assert.rejects(readCLIUsage('/fixture/agent', { directory: '/fixture/empty',
    launch() { throw new Error('SECRET_SENTINEL') } }), /python3 and the official CLI are required/)
  for (const stream of ['child', 'stdin', 'stdout']) {
    const current = fixture()
    const emitter = stream === 'child' ? current.child : current.child[stream]
    emitter.emit('error', new Error('SECRET_SENTINEL'))
    await assert.rejects(current.result, error => !error.message.includes('SECRET_SENTINEL'))
    assert.deepEqual(current.signals, ['SIGTERM'])
    current.close()
  }
  const closed = fixture()
  closed.output('SECRET_SENTINEL')
  closed.child.emit('close', 127)
  await assert.rejects(closed.result, /CLI usage unavailable/)
})

test('output is bounded across all state transitions', async () => {
  const current = fixture()
  current.output(Buffer.alloc(600 * 1024, ' '))
  current.output(startup)
  current.output(Buffer.alloc(500 * 1024, ' '))
  await assert.rejects(current.result, /exceeds 1 MiB/)
  assert.deepEqual(current.writes, ['/usage'])
  assert.deepEqual(current.signals, ['SIGTERM'])
  current.close()
})

const helper = fileURLToPath(new URL('../lib/terminal.py', import.meta.url))
const hasPython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0

function processAlive(identifier) {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(identifier)], { encoding: 'utf8' })
  return result.status === 0 && result.stdout.trim() && !result.stdout.trim().startsWith('Z')
}

test('PTY helper owns terminal dimensions and kills/reaps its inner session on TERM, INT and stdin EOF',
  { skip: !hasPython, timeout: 10000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cursor-usage-test-'))
    const executable = path.join(directory, 'fixture-agent')
    await writeFile(executable, `#!/usr/bin/env python3
import json, os, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
child = os.fork()
if child == 0:
    while True:
        time.sleep(1)
print(json.dumps({'pid': os.getpid(), 'child': child, 'group': os.getpgrp(), 'size': list(os.get_terminal_size()), 'arguments': sys.argv[1:]}), flush=True)
while True:
    time.sleep(1)
`, { mode: 0o700 })
    try {
      for (const termination of ['SIGTERM', 'SIGINT', 'EOF']) {
        const child = spawn('python3', ['-u', helper, executable], {
          cwd: directory, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        })
        const closed = once(child, 'close')
        let identifiers
        try {
          const [output] = await once(child.stdout, 'data')
          identifiers = JSON.parse(output.toString('utf8'))
          assert.deepEqual(identifiers.size, [160, 40])
          assert.deepEqual(identifiers.arguments, ['--mode', 'ask'])
          assert.equal(identifiers.group, identifiers.pid)
          assert.notEqual(identifiers.group, child.pid)
          if (termination === 'EOF') child.stdin.end()
          else child.kill(termination)
          await closed
          assert.equal(Boolean(processAlive(identifiers.pid)), false)
          assert.equal(Boolean(processAlive(identifiers.child)), false)
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
          if (identifiers && processAlive(identifiers.pid)) process.kill(-identifiers.group, 'SIGKILL')
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
