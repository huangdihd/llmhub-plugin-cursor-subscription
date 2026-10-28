import { spawn } from 'node:child_process'

/** Ask the official CLI for identity without reading its credential store. */
export function readAccountIdentity(executable, { directory, signal, timeoutMilliseconds = 8000,
  launch = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cursor identity query cancelled'))
    const child = launch(executable, ['status', '--format', 'json'], {
      cwd: directory, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    let size = 0
    let settled = false
    const buffers = []
    const deadline = setTimeout(() => fail('Cursor identity query timed out'), timeoutMilliseconds)
    const abort = () => fail('Cursor identity query cancelled')
    function finish() {
      settled = true
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
    }
    function fail(message) {
      if (settled) return
      finish()
      child.kill('SIGTERM')
      reject(new Error(message))
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => fail('Cursor identity query could not start'))
    child.stdout.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > 256 * 1024) return fail('Cursor identity response exceeds 256 KiB')
      buffers.push(chunk)
    })
    child.on('close', (code) => {
      if (settled) return
      if (code !== 0) return fail('Cursor identity query failed; check this Provider’s CLI authentication')
      let value
      try { value = JSON.parse(Buffer.concat(buffers).toString('utf8')) }
      catch { return fail('Cursor identity query returned invalid JSON') }
      const email = value?.userInfo?.email
      if (value?.isAuthenticated !== true || typeof email !== 'string' || email.length > 320 ||
          !/^[^\s@]+@[^\s@]+$/.test(email)) {
        return fail('Cursor identity unavailable; authenticate this Provider before querying quota')
      }
      finish()
      resolve({ email })
    })
  })
}
