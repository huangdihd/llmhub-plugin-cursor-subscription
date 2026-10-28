const origin = 'https://cursor.com'
const apiOrigin = 'https://api2.cursor.sh'
const maximumResponseBytes = 1024 * 1024

function usageError(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode })
}

export function usageSession(provider) {
  const token = provider.connection?.extra?.cursor_session_token
  if (typeof token !== 'string' || !token) {
    throw usageError('Configure this Provider’s quota authentication: explicit cli_login, a Cursor user API key, or its cursor_session_token', 400)
  }
  // Accept only the named cookie value, never an arbitrary Cookie header.
  if (token.length > 16384 || !/^[\x21-\x7e]+$/.test(token) || /[;,"\\]/.test(token) || token.includes('WorkosCursorSessionToken=')) {
    throw usageError('cursor_session_token must contain only the WorkosCursorSessionToken cookie value', 400)
  }
  return token
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw usageError(`Cursor returned an invalid ${label}`)
  }
  return value
}

function percentage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw usageError('Cursor returned an invalid usage percentage')
  }
  return value
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value.includes('T') || !Number.isFinite(Date.parse(value))) {
    throw usageError(`Cursor returned an invalid ${label}`)
  }
  return new Date(value).toISOString()
}

function email(value) {
  if (typeof value !== 'string' || value.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(value)) {
    throw usageError('Cannot verify that quota and inference credentials belong to the same Cursor account')
  }
  return value.trim().toLowerCase()
}

/** Decode reported quota only: missing data must never become a false 0% used. */
export function normalizeUsage(providerName, summary, shared, now = new Date()) {
  record(summary, 'usage summary')
  record(shared, 'shared quota')
  if (summary.membershipType !== undefined && typeof summary.membershipType !== 'string') {
    throw usageError('Cursor returned an invalid membership type')
  }
  const plan = summary.membershipType
  const unified = shared.isUnified === true || plan?.toLowerCase().startsWith('unified_')
  const windows = []
  if (unified) {
    if (shared.isUnified !== true) throw usageError('Cursor did not confirm the X shared quota; refusing to substitute legacy usage')
    const hasLimit = typeof shared.includedLimitZero === 'boolean'
      ? !shared.includedLimitZero : shared.hasNonZeroIncludedLimit
    const trialEnds = shared.sandTrialExpiresAt === undefined ? undefined
      : timestamp(shared.sandTrialExpiresAt, 'trial expiry')
    const trial = hasLimit !== true && trialEnds !== undefined && Date.parse(trialEnds) > now.getTime()
    if (hasLimit !== true && !trial) throw usageError('Cursor reports no active included shared quota or trial')
    const used = percentage(shared.usagePercent)
    const resetAt = trial ? undefined : timestamp(shared.nextResetTimestampUtc, 'shared quota reset')
    if (resetAt && Date.parse(resetAt) <= now.getTime()) throw usageError('Cursor returned an expired shared quota window; retry refresh')
    windows.push({ id: 'x-shared', label: trial ? 'X shared trial' : 'X shared weekly quota',
      used_percent: used, ...(resetAt ? { reset_at: resetAt } : {}),
      detail: trial ? `Trial expires ${trialEnds}; this is not a recurring reset`
        : 'Shared across Cursor and Grok; third-party Claude/GPT/Gemini usage is separate' })
  } else {
    const planUsage = record(summary.individualUsage?.plan, 'individual plan quota')
    let used = planUsage.totalPercentUsed
    if (used === undefined) {
      if (typeof planUsage.used !== 'number' || !Number.isFinite(planUsage.used) || planUsage.used < 0 ||
          typeof planUsage.limit !== 'number' || !Number.isFinite(planUsage.limit) || planUsage.limit <= 0) {
        throw usageError('Cursor did not return a measurable individual plan quota')
      }
      used = planUsage.used / planUsage.limit * 100
    }
    windows.push({ id: 'cursor-plan', label: 'Cursor included plan', used_percent: percentage(used),
      ...(summary.billingCycleEnd ? { reset_at: timestamp(summary.billingCycleEnd, 'billing reset') } : {}) })
  }
  return { provider: providerName, protocol: 'cursor-subscription:cursor',
    ...(plan ? { plan } : {}), windows, fetched_at: now.toISOString() }
}

function withDeadline(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(usageError('Cursor quota request timed out', 504))
    const finish = () => signal.removeEventListener('abort', abort)
    Promise.resolve(promise).then(value => { finish(); resolve(value) }, error => { finish(); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

async function readJSON(response, signal) {
  if (!response.headers.get('content-type')?.includes('application/json') || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw usageError('Cursor quota endpoint did not return JSON')
  }
  const reader = response.body.getReader()
  const buffers = []
  let length = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw usageError('Cursor quota request timed out', 504)
      const { done, value } = await reader.read()
      if (signal.aborted) throw usageError('Cursor quota request timed out', 504)
      if (done) break
      length += value.length
      if (length > maximumResponseBytes) throw usageError('Cursor quota response exceeds 1 MiB')
      buffers.push(value)
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers))) }
    catch { throw usageError('Cursor returned malformed quota JSON') }
  } catch (error) {
    if (signal.aborted) throw usageError('Cursor quota request timed out', 504)
    if (error.statusCode) throw error
    throw usageError('Cursor quota response could not be read')
  } finally {
    signal.removeEventListener('abort', abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function fetchSubscriptionUsage(provider, { fetcher = fetch, accountIdentity, cliUsage, assertCurrent = () => {},
  timeoutMilliseconds = 20000, now = () => new Date() } = {}) {
  const extra = provider.connection?.extra ?? {}
  const useCLI = !extra.cursor_session_token && extra.auth_mode === 'cli_login'
  const useApiKey = !extra.cursor_session_token && (extra.auth_mode ?? 'api_key') === 'api_key' && extra.cursor_api_key
  const token = useApiKey || useCLI ? undefined : usageSession(provider)
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), timeoutMilliseconds)
  async function request(url, headers, method = 'GET') {
    assertCurrent()
    if (controller.signal.aborted) throw usageError('Cursor quota request timed out', 504)
    let response
    try {
      response = await withDeadline(fetcher(url, {
        method, headers: { accept: 'application/json', ...headers,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{}' } : {}),
        signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      }), controller.signal)
    } catch {
      throw usageError(controller.signal.aborted ? 'Cursor quota request timed out' : 'Cursor quota request failed; check network access',
        controller.signal.aborted ? 504 : 502)
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      if ([401, 403].includes(response.status)) {
        throw usageError(useApiKey ? 'Cursor rejected quota access; check this Provider’s user API key or configure its same-account dashboard session'
          : 'Cursor quota session expired or was rejected; update this Provider’s cursor_session_token', 401)
      }
      throw usageError(`Cursor quota endpoint HTTP ${response.status}`)
    }
    return record(await readJSON(response, controller.signal), 'quota response')
  }
  try {
    assertCurrent()
    if (useCLI) {
      if (!cliUsage) throw usageError('CLI quota reader is unavailable')
      const result = record(await withDeadline(cliUsage(controller.signal), controller.signal), 'CLI usage')
      assertCurrent()
      if (typeof result.plan !== 'string' || !result.plan) throw usageError('Cursor CLI returned an invalid plan')
      return { provider: provider.name, protocol: 'cursor-subscription:cursor', plan: result.plan,
        windows: [{ id: 'cli-included', label: 'CLI included plan', used_percent: percentage(result.used_percent),
          detail: `Official /usage display${result.reset_label ? `; ${result.reset_label} (UTC, date only)` : ''}; not a verified X shared weekly meter` }],
        fetched_at: now().toISOString() }
    }
    if (useApiKey) {
      const key = extra.cursor_api_key
      if (typeof key !== 'string' || !/^[\x21-\x7e]+$/.test(key.trim())) throw usageError('Invalid Cursor user API key', 400)
      const exchanged = await request(`${apiOrigin}/auth/exchange_user_api_key`, { authorization: `Bearer ${key.trim()}` }, 'POST')
      const accessToken = exchanged.accessToken
      if (typeof accessToken !== 'string' || !/^[\x21-\x7e]+$/.test(accessToken)) throw usageError('Cursor did not return a valid quota access token')
      // The token is derived from this exact inference key, not a second account.
      // Neither it nor the returned refresh token is persisted or logged.
      const shared = await request(`${apiOrigin}/aiserver.v1.DashboardService/GetSandUsageStatus`, {
        authorization: `Bearer ${accessToken}`, 'Connect-Protocol-Version': '1', 'x-cursor-client-type': 'cli',
      }, 'POST')
      if (shared.isUnified !== true) throw usageError('API-key quota query did not return an X shared pool; legacy plans require a same-account dashboard session')
      assertCurrent()
      return normalizeUsage(provider.name, { membershipType: shared.cursorPlanName || shared.grokPlanLabel }, shared, now())
    }
    const identity = await withDeadline(accountIdentity(controller.signal), controller.signal)
    if (controller.signal.aborted) throw usageError('Cursor quota request timed out', 504)
    assertCurrent()
    const headers = { cookie: `WorkosCursorSessionToken=${token}` }
    const dashboard = await request(`${origin}/api/auth/me`, headers)
    if (email(identity?.email) !== email(dashboard.email)) {
      throw usageError('Quota session belongs to a different Cursor account; update this Provider’s cursor_session_token', 409)
    }
    const summary = await request(`${origin}/api/usage-summary`, headers)
    const shared = await request(`${origin}/api/dashboard/get-sand-usage-status`, { ...headers, origin }, 'POST')
    assertCurrent()
    return normalizeUsage(provider.name, summary, shared, now())
  } finally {
    clearTimeout(deadline)
    controller.abort()
  }
}
