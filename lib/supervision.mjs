import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const TERMINATION_GRACE_MS = 250
const SHUTDOWN_DEADLINE_MS = 1_000
let installed

/**
 * Worker-only integration seam for pinned cursor-api-proxy 1.7.0. Install before
 * importing upstream: its cancellation forgets children before they actually
 * exit. These lifetime-long patches must never run in the host/plugin process.
 * Only detached children we spawn own a process group; other children are
 * signalled individually. No discovery of unrelated processes is performed.
 */
export function installSupervision() {
  if (installed) return installed
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error('Cursor process supervision requires macOS or Linux')
  }

  const originalSpawn = childProcess.spawn
  const originalProcessKill = process.kill
  const children = new Set()
  const groups = new Map()
  const failures = []
  let shuttingDown = false
  let shutdownPromise

  function isTermination(signal) {
    return signal === undefined || signal === 15 ||
      (typeof signal === 'string' && signal.toUpperCase() === 'SIGTERM')
  }

  function signalOwned(record, signal) {
    if (!record.detached && record.exited) return
    try {
      originalProcessKill.call(process, record.detached ? -record.pid : record.pid, signal)
    } catch (error) {
      // ESRCH is the normal race with exit. Other failures must reach shutdown,
      // not become uncaught exceptions in an escalation timer.
      if (error.code !== 'ESRCH') failures.push(error)
    }
  }

  function hardKill(record) {
    if (record.hardKilled) return
    record.hardKilled = true
    clearTimeout(record.timer)
    groups.delete(record.pid)
    signalOwned(record, 'SIGKILL')
  }

  function armEscalation(record) {
    if (record.closed || record.hardKilled || record.timer) return
    // Keep this timer referenced even if upstream unrefs the child. Repeated
    // TERM requests must not postpone the original escalation deadline.
    record.timer = setTimeout(() => hardKill(record), TERMINATION_GRACE_MS)
  }

  childProcess.spawn = function (...arguments_) {
    if (shuttingDown) throw new Error('Cursor worker is shutting down')
    const child = originalSpawn.apply(this, arguments_)
    if (!child.pid) return child // Failed spawn: upstream retains its error event.
    const options = Array.isArray(arguments_[1]) ? arguments_[2] : arguments_[1]
    let resolveClosed
    const record = {
      pid: child.pid,
      detached: options?.detached === true,
      exited: false,
      closed: false,
      hardKilled: false,
      timer: undefined,
      completion: new Promise((resolve) => { resolveClosed = resolve }),
    }
    children.add(record)
    if (record.detached) groups.set(record.pid, record)

    const originalChildKill = child.kill
    child.kill = function (signal) {
      const result = originalChildKill.call(this, signal)
      if (this === child && isTermination(signal ?? undefined)) armEscalation(record)
      return result
    }
    child.once('exit', () => {
      record.exited = true
      // Helpers can inherit pipes and prevent 'close' altogether. Kill the
      // remaining owned group on exit as well as close, without a stale timer.
      hardKill(record)
    })
    child.once('close', () => {
      record.exited = true
      record.closed = true
      hardKill(record)
      children.delete(record)
      resolveClosed()
    })
    return child
  }

  process.kill = function (pid, signal) {
    const result = originalProcessKill.call(this, pid, signal)
    const record = typeof pid === 'number' && pid < 0 ? groups.get(-pid) : undefined
    if (record && isTermination(signal)) armEscalation(record)
    return result
  }
  syncBuiltinESMExports()

  installed = {
    shutdown() {
      if (shutdownPromise) return shutdownPromise
      shuttingDown = true
      shutdownPromise = (async () => {
        const pending = [...children]
        for (const record of pending) {
          if (record.hardKilled) continue
          signalOwned(record, 'SIGTERM')
          armEscalation(record)
        }
        let deadline
        try {
          await Promise.race([
            Promise.all(pending.map((record) => record.completion)),
            new Promise((_, reject) => {
              deadline = setTimeout(() => {
                for (const record of children) hardKill(record)
                reject(new Error('Cursor child processes did not close before shutdown deadline'))
              }, SHUTDOWN_DEADLINE_MS)
            }),
          ])
        } finally {
          clearTimeout(deadline)
        }
        if (failures.length) throw new AggregateError(failures, 'Cursor process cleanup failed')
      })()
      return shutdownPromise
    },
  }
  return installed
}
