import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const terminalHelper = fileURLToPath(new URL('./terminal.py', import.meta.url))
const maximumOutputBytes = 1024 * 1024
const invalidPanel = 'Cursor CLI returned an unsupported usage panel'

function terminalText(value) {
  return stripVTControlCharacters(value).replace(/\r\n?/g, '\n')
    .replace(/[│┃]/g, ' ')
}

/** The current included plan, not evidence of an X shared pool or an exact reset date. */
export function parseCLIUsage(output) {
  const text = terminalText(output)
  // A redraw can contain older panels. Only the last header is authoritative.
  const headers = [...text.matchAll(/(?:^|\n)[ \t]*Usage[ \t]*•[^\n]*/g)]
  const header = headers.at(-1)
  if (!header) throw new Error(invalidPanel)
  const panel = text.slice(header.index).trimStart()
  const title = /^Usage[ \t]*•[ \t]*([A-Za-z][A-Za-z0-9 +()-]{0,63}?)(?:[ \t]+Resets[ \t]+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12][0-9]|3[01])(?:,? [0-9]{4})?))?[ \t]*\n/.exec(panel)
  const included = [...panel.matchAll(/(?:^|\n)[ \t]*Included[ \t]+([0-9]+(?:\.[0-9]+)?)%[ \t]+used[ \t]*[█░▓▒]*[ \t]*(?=\n|$)/g)]
  if (!title || !/Monthly plan and on-demand usage/.test(panel) ||
      !/Category[ \t]+Current[ \t]+Usage/.test(panel) || !/Esc to close/.test(panel) || included.length !== 1) {
    throw new Error(invalidPanel)
  }
  const used = Number(included[0][1])
  const plan = title[1].trim()
  if (!Number.isFinite(used) || used < 0 || used > 100 || !plan || /\bResets\b/.test(plan)) {
    throw new Error(invalidPanel)
  }
  return { plan, used_percent: used, ...(title[2] ? { reset_label: `Resets ${title[2]}` } : {}) }
}

/**
 * Read the registered interactive /usage command using existing official CLI auth.
 * The caller supplies an EMPTY temporary workspace, never a user's project: only
 * that disposable directory may be accepted by the workspace-trust interaction.
 */
export function readCLIUsage(executable, { directory, signal, timeoutMilliseconds = 15000,
  launch = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cursor CLI usage query cancelled'))
    if (typeof executable !== 'string' || !executable || typeof directory !== 'string' || !directory ||
        !Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
      return reject(new Error('Cursor CLI usage requires an executable, temporary workspace and positive deadline'))
    }
    let child
    try {
      // Python is required only for quota's PTY; no shell, prompt, ACP or -p mode.
      child = launch('python3', ['-u', terminalHelper, executable], {
        cwd: directory, env: process.env, detached: true, stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      return reject(new Error('Cursor CLI usage could not start; python3 and the official CLI are required'))
    }
    let settled = false
    let closed = false
    let state = 'startup'
    let trusted = false
    let size = 0
    let output = ''
    let escalation
    const decoder = new StringDecoder('utf8')
    const deadline = setTimeout(() => finish(new Error('Cursor CLI usage query timed out')), timeoutMilliseconds)
    const abort = () => finish(new Error('Cursor CLI usage query cancelled'))

    function terminate() {
      if (closed) return
      // terminal.py owns and reaps the separate PTY session before this fallback.
      try { child.kill('SIGTERM') } catch { /* A concurrent exit needs no signal. */ }
      escalation = setTimeout(() => {
        if (closed) return
        try { child.kill('SIGKILL') } catch { /* The child may already have exited. */ }
      }, 250)
      escalation.unref()
    }

    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      output = ''
      terminate()
      if (error) reject(error)
      else resolve(value)
    }

    function send(value, nextState) {
      state = nextState
      output = ''
      try { child.stdin.write(value) }
      catch { finish(new Error('Cursor CLI usage input failed')) }
    }

    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => finish(new Error('Cursor CLI usage could not start; python3 and the official CLI are required')))
    child.stdin.on('error', () => finish(new Error('Cursor CLI usage input failed')))
    child.stdout.on('error', () => finish(new Error('Cursor CLI usage output failed')))
    child.on('close', () => {
      closed = true
      clearTimeout(escalation)
      if (!settled) finish(new Error('Cursor CLI usage unavailable; check CLI authentication and interactive command support'))
    })
    child.stdout.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maximumOutputBytes) return finish(new Error('Cursor CLI usage response exceeds 1 MiB'))
      // Re-strip the accumulated buffer, not individual chunks: UTF-8 and ANSI
      // escape sequences can both cross a pipe read boundary.
      output += decoder.write(chunk)
      const text = terminalText(output)
      if (state === 'startup') {
        if (!trusted && text.includes('Workspace Trust Required')) {
          trusted = true
          send('a', 'startup')
          return
        }
        if (text.includes('Cursor Agent') && text.includes('→ Plan, search, build anything')) {
          send('/usage', 'suggestion')
        }
        return
      }
      if (state === 'suggestion') {
        // Never press Enter merely because the typed text was echoed. Unknown
        // slash commands may be treated as inference prompts by the CLI.
        if (/(?:^|\n)[ \t>❯→]*\/usage[ \t]+Show plan and on-demand usage[ \t]*(?:\n|$)/.test(text)) {
          send('\r', 'panel')
        }
        return
      }
      if (!text.includes('Esc to close')) return
      try { finish(undefined, parseCLIUsage(output)) }
      catch { finish(new Error(invalidPanel)) }
    })
    // Cover cancellation that occurred synchronously inside an injected launch.
    if (signal?.aborted) abort()
  })
}
