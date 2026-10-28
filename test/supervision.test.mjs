import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

const supervisionURL = new URL('../lib/supervision.mjs', import.meta.url).href
const supported = ['darwin', 'linux'].includes(process.platform)
const stubbornSource = `
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 100)
  setTimeout(() => process.exit(98), 4_000)
  console.log('ready')
`

// Every patch lives in a fresh disposable process, never in the test runner.
// Fixtures also have their own lifetime limit so failed assertions cannot leak.
async function runWorker(source) {
  const script = `
    import assert from 'node:assert/strict'
    import childProcess, { spawn as namedSpawn } from 'node:child_process'
    import { once } from 'node:events'
    import { setTimeout as delay } from 'node:timers/promises'
    import { installSupervision } from ${JSON.stringify(supervisionURL)}
    const originalSpawn = childProcess.spawn
    const originalKill = process.kill
    const cleanup = []
    const stubbornSource = ${JSON.stringify(stubbornSource)}
    async function launch(source = stubbornSource, detached = true, spawn = childProcess.spawn) {
      const child = spawn(process.execPath, ['-e', source], {
        detached, stdio: ['ignore', 'pipe', 'ignore'],
      })
      cleanup.push({ child, detached })
      const completion = once(child, 'close')
      const [output] = await once(child.stdout, 'data')
      return { child, completion, output: output.toString() }
    }
    let supervision
    try {
      ${source}
    } finally {
      try { await supervision?.shutdown() } finally {
        for (const { child, detached } of cleanup) {
          // A closed child has already been reaped; do not signal a reused PID.
          if (child.exitCode !== null || child.signalCode !== null) continue
          try { originalKill.call(process, detached ? -child.pid : child.pid, 'SIGKILL') }
          catch (error) { if (error.code !== 'ESRCH') throw error }
        }
      }
    }
  `
  const worker = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  worker.stdout.on('data', (data) => { output += data })
  worker.stderr.on('data', (data) => { output += data })
  const timeout = setTimeout(() => worker.kill('SIGKILL'), 6_000)
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      worker.once('error', reject)
      worker.once('close', (code, signal) => resolve([code, signal]))
    })
    assert.equal(code, 0, `Worker failed (${signal ?? code}): ${output}`)
  } finally {
    clearTimeout(timeout)
  }
}

const options = { skip: !supported, timeout: 8_000 }

for (const expression of [
  'process.kill(-child.pid)',
  "process.kill(-child.pid, 'SIGTERM')",
  'process.kill(-child.pid, 15)',
  'child.kill()',
]) {
  test(`TERM escalates despite repeated cancellation: ${expression}`, options, async () => {
    await runWorker(`
      supervision = installSupervision()
      assert.equal(installSupervision(), supervision)
      assert.equal(namedSpawn, childProcess.spawn)
      assert.notEqual(namedSpawn, originalSpawn)
      const { child, completion } = await launch()
      const start = performance.now()
      ${expression}
      for (let repeat = 0; repeat < 3; repeat++) {
        await delay(40)
        ${expression}
      }
      const [code, signal] = await completion
      assert.equal(code, null)
      assert.equal(signal, 'SIGKILL')
      assert.ok(performance.now() - start >= 150, 'TERM grace period was skipped')
      assert.ok(performance.now() - start < 1_200, 'escalation was delayed')
    `)
  })
}

test('shutdown is idempotent, awaits child close, and rejects new spawns', options, async () => {
  await runWorker(`
    supervision = installSupervision()
    const detached = await launch()
    const attached = await launch(stubbornSource, false)
    const start = performance.now()
    const shutdown = supervision.shutdown()
    assert.equal(supervision.shutdown(), shutdown)
    assert.throws(() => childProcess.spawn(process.execPath), /shutting down/)
    await shutdown
    assert.deepEqual(await detached.completion, [null, 'SIGKILL'])
    assert.deepEqual(await attached.completion, [null, 'SIGKILL'])
    assert.ok(performance.now() - start < 1_200)
  `)
})

test('child.kill TERM also escalates for a non-detached child', options, async () => {
  await runWorker(`
    supervision = installSupervision()
    const { child, completion } = await launch(stubbornSource, false)
    child.kill('SIGTERM')
    assert.deepEqual(await completion, [null, 'SIGKILL'])
  `)
})

for (const inheritedPipes of [false, true]) {
  test(`leader exit removes stubborn group helpers (inherited pipes: ${inheritedPipes})`, options, async () => {
    const helperSource = `
      process.on('SIGTERM', () => {})
      setTimeout(() => process.exit(98), 4_000)
      process.send('ready')
    `
    const leaderSource = `
      const { spawn } = require('node:child_process')
      const helper = spawn(process.execPath, ['-e', ${JSON.stringify(helperSource)}], {
        stdio: ['ignore', ${inheritedPipes ? "'inherit'" : "'ignore'"}, 'ignore', 'ipc'],
      })
      helper.once('message', () => {
        console.log(helper.pid)
        process.on('SIGTERM', () => process.exit(0))
      })
      setTimeout(() => process.exit(98), 4_000)
    `
    await runWorker(`
      supervision = installSupervision()
      const { child, completion, output } = await launch(${JSON.stringify(leaderSource)})
      const helperPid = Number(output.trim())
      assert.ok(helperPid > 0)
      const start = performance.now()
      child.kill('SIGTERM')
      assert.deepEqual(await completion, [0, null])
      // On Linux an orphan can briefly remain a zombie until PID 1 reaps it.
      // kill(0) alone would incorrectly report that already-dead helper alive.
      let dead = false
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          originalKill.call(process, helperPid, 0)
          if (process.platform === 'linux') {
            const { readFile } = await import('node:fs/promises')
            try {
              const status = await readFile('/proc/' + helperPid + '/stat', 'utf8')
              if (status.slice(status.lastIndexOf(')') + 2).startsWith('Z')) dead = true
            } catch (error) {
              if (error.code !== 'ENOENT') throw error
              dead = true
            }
          }
        } catch (error) {
          assert.equal(error.code, 'ESRCH')
          dead = true
        }
        if (dead) break
        await delay(20)
      }
      assert.ok(dead, 'helper outlived its process-group leader')
      assert.ok(performance.now() - start < 1_200)
    `)
  })
}

test('unknown groups and positive-PID signals are not intercepted', options, async () => {
  await runWorker(`
    const unrelated = await launch(stubbornSource, true, originalSpawn)
    supervision = installSupervision()
    const owned = await launch()
    process.kill(-unrelated.child.pid, 'SIGTERM')
    process.kill(owned.child.pid, 'SIGTERM')
    await delay(400)
    assert.equal(unrelated.child.signalCode, null)
    assert.equal(owned.child.signalCode, null)
    assert.equal(process.kill(-unrelated.child.pid, 0), true)
    assert.equal(process.kill(owned.child.pid, 0), true)
    await supervision.shutdown()
    assert.equal(process.kill(-unrelated.child.pid, 0), true)
    originalKill.call(process, -unrelated.child.pid, 'SIGKILL')
    await unrelated.completion
  `)
})

test('normal detached exit and cancelled timers leave no stale cleanup state', options, async () => {
  await runWorker(`
    supervision = installSupervision()
    const source = "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setTimeout(() => process.exit(98), 4_000)"
    const { child, completion } = await launch(source)
    child.kill('SIGTERM')
    assert.deepEqual(await completion, [0, null])
    await delay(300)
    await supervision.shutdown()
  `)
})

test('failed spawns retain their error semantics and do not block shutdown', options, async () => {
  await runWorker(`
    supervision = installSupervision()
    const failed = childProcess.spawn('/nonexistent-cursor-supervision-fixture')
    const closed = new Promise((resolve) => failed.once('close', resolve))
    const [error] = await once(failed, 'error')
    assert.equal(error.code, 'ENOENT')
    await closed
    await supervision.shutdown()
  `)
})
