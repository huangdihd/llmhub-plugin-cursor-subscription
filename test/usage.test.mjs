import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchSubscriptionUsage, normalizeUsage, usageSession } from '../lib/usage.mjs'

const now = new Date('2026-10-28T12:00:00Z')
const summary = { membershipType: 'unified_premium', limitType: 'user' }
const shared = { isUnified: true, includedLimitZero: false, usagePercent: 12.5,
  nextResetTimestampUtc: '2026-11-01T00:00:00Z', hasAvailableUsage: true }
const provider = (name = 'cursor-one', token = 'fixture-session') => ({ name,
  connection: { extra: { cursor_session_token: token } } })
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
})

function fixture(overrides = {}) {
  const calls = []
  const responses = {
    '/api/auth/me': { email: 'account@example.invalid' },
    '/api/usage-summary': summary,
    '/api/dashboard/get-sand-usage-status': shared,
    ...overrides,
  }
  const options = {
    now: () => now,
    accountIdentity: async () => ({ email: 'ACCOUNT@example.invalid' }),
    fetcher: async (url, request) => {
      calls.push({ url, request })
      const data = responses[new URL(url).pathname]
      return data instanceof Response ? data : json(data)
    },
  }
  return { options, calls }
}

test('shared quota uses reported percentage and reset, not legacy usage or cents', () => {
  const result = normalizeUsage('one', { ...summary, individualUsage: { plan: { totalPercentUsed: 0 } } }, shared, now)
  assert.equal(result.protocol, 'cursor-subscription:cursor')
  assert.equal(result.provider, 'one')
  assert.equal(result.plan, 'unified_premium')
  assert.equal(result.windows[0].used_percent, 12.5)
  assert.equal(result.windows[0].reset_at, '2026-11-01T00:00:00.000Z')
  assert.equal(result.credits, undefined)
  assert.equal(result.fetched_at, now.toISOString())
  assert.equal(normalizeUsage('one', summary, { ...shared, usagePercent: 0.36 }, now).windows[0].used_percent, 0.36)
  assert.equal(normalizeUsage('one', summary, { ...shared, usagePercent: 0 }, now).windows[0].used_percent, 0)
})

test('unknown, malformed, absent or expired shared quotas never turn into zero usage', () => {
  for (const value of [undefined, null, '12', NaN, Infinity, -1, 101]) {
    assert.throws(() => normalizeUsage('one', summary, { ...shared, usagePercent: value }, now), /invalid usage/)
  }
  for (const change of [{ isUnified: false }, { isUnified: undefined }, { includedLimitZero: true },
    { nextResetTimestampUtc: undefined }, { nextResetTimestampUtc: '2025-01-01T00:00:00Z' }]) {
    assert.throws(() => normalizeUsage('one', summary, { ...shared, ...change }, now))
  }
  assert.throws(() => normalizeUsage('one', {}, {}, now), /invalid individual plan/)
})

test('trial expiry is not reported as a recurring weekly reset', () => {
  const result = normalizeUsage('one', summary, { ...shared, includedLimitZero: true,
    sandTrialExpiresAt: '2026-10-30T00:00:00Z' }, now)
  assert.match(result.windows[0].label, /trial/)
  assert.equal(result.windows[0].reset_at, undefined)
  assert.match(result.windows[0].detail, /2026-10-30/)
})

test('legacy individual plans use reported percentage or explicit used/limit, never absent counters', () => {
  const legacy = { membershipType: 'pro', individualUsage: { plan: { used: 500, limit: 2000 } } }
  assert.equal(normalizeUsage('one', legacy, {}, now).windows[0].used_percent, 25)
  legacy.individualUsage.plan.totalPercentUsed = 0.36
  assert.equal(normalizeUsage('one', legacy, {}, now).windows[0].used_percent, 0.36)
  assert.throws(() => normalizeUsage('one', { membershipType: 'pro', individualUsage: { plan: {} } }, {}, now), /measurable/)
})

test('fetch checks inference identity before reading usage and sends only the selected session to cursor.com', async () => {
  const { options, calls } = fixture()
  const result = await fetchSubscriptionUsage(provider(), options)
  assert.equal(result.windows[0].used_percent, 12.5)
  assert.deepEqual(calls.map(call => new URL(call.url).pathname),
    ['/api/auth/me', '/api/usage-summary', '/api/dashboard/get-sand-usage-status'])
  for (const { url, request } of calls) {
    assert.equal(new URL(url).origin, 'https://cursor.com')
    assert.equal(request.headers.cookie, 'WorkosCursorSessionToken=fixture-session')
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.redirect, 'error')
    assert.equal(request.credentials, 'omit')
  }
  assert.equal(calls[2].request.method, 'POST')
  assert.equal(calls[2].request.body, '{}')
  assert.equal(calls[2].request.headers.origin, 'https://cursor.com')
})

test('mismatched or missing account identity stops before querying quota', async () => {
  for (const email of ['other@example.invalid', undefined]) {
    const { options, calls } = fixture({ '/api/auth/me': { email } })
    await assert.rejects(fetchSubscriptionUsage(provider(), options), /different Cursor account|Cannot verify/)
    assert.equal(calls.length, 1)
  }
})

test('missing session and cookie/header injection fail without network or CLI startup', async () => {
  for (const token of [undefined, '', 'bad\r\nheader', 'value; other=secret', '"quoted"', 'WorkosCursorSessionToken=foo']) {
    const current = provider('one', token)
    if (token === undefined) current.connection.extra = {}
    assert.throws(() => usageSession(current), /cursor_session_token/)
    await assert.rejects(fetchSubscriptionUsage(current, { accountIdentity() { assert.fail('CLI started') } }), /cursor_session_token/)
  }
})

test('each provider uses its own dashboard session without cookie storage or inherited credentials', async () => {
  const first = fixture()
  const second = fixture()
  await Promise.all([fetchSubscriptionUsage(provider('one', 'first'), first.options),
    fetchSubscriptionUsage(provider('two', 'second'), second.options)])
  assert.ok(first.calls.every(call => call.request.headers.cookie.endsWith('=first')))
  assert.ok(second.calls.every(call => call.request.headers.cookie.endsWith('=second')))
})

test('authentication and upstream errors never expose arbitrary response bodies or secrets', async () => {
  for (const status of [401, 403, 429, 500]) {
    const { options } = fixture({ '/api/auth/me': json({ error: 'SENTINEL_SECRET' }, status) })
    await assert.rejects(fetchSubscriptionUsage(provider(), options), error => {
      assert.ok(!error.message.includes('SENTINEL'))
      assert.ok(!error.message.includes('fixture-session'))
      return /expired|HTTP/.test(error.message)
    })
  }
})

test('malformed, redirected and oversized responses fail safely', async () => {
  for (const response of [new Response('secret', { headers: { 'content-type': 'text/html' } }),
    new Response('broken SECRET', { headers: { 'content-type': 'application/json' } }),
    json({ email: 'x'.repeat(1024 * 1024 + 1) }), json({}, 302)]) {
    const { options } = fixture({ '/api/auth/me': response })
    await assert.rejects(fetchSubscriptionUsage(provider(), options), error => !error.message.includes('SECRET'))
  }
})

test('timeout covers CLI identity and a stalled response body', async () => {
  const { options } = fixture()
  await assert.rejects(fetchSubscriptionUsage(provider(), { ...options, timeoutMilliseconds: 20,
    accountIdentity: () => new Promise(() => {}) }), /timed out/)
  const stalled = fixture({ '/api/auth/me': new Response(new ReadableStream(), {
    headers: { 'content-type': 'application/json' },
  }) })
  await assert.rejects(fetchSubscriptionUsage(provider(), { ...stalled.options, timeoutMilliseconds: 20 }), /timed out/)
})

test('network and body-reader failures do not expose transport secrets', async () => {
  const { options } = fixture()
  await assert.rejects(fetchSubscriptionUsage(provider(), { ...options,
    fetcher: async () => { throw new Error('SECRET_SENTINEL') },
  }), error => !error.message.includes('SECRET') && /network/.test(error.message))
  const broken = fixture({ '/api/auth/me': new Response(new ReadableStream({
    start(controller) { controller.error(new Error('SECRET_SENTINEL')) },
  }), { headers: { 'content-type': 'application/json' } }) })
  await assert.rejects(fetchSubscriptionUsage(provider(), broken.options),
    error => !error.message.includes('SECRET') && /could not be read/.test(error.message))
})

test('API-key mode exchanges only its own key and queries the bearer-authenticated shared pool without CLI or cookies', async () => {
  const calls = []
  const current = provider('api-account')
  current.connection.extra = { cursor_api_key: 'own-key' }
  const result = await fetchSubscriptionUsage(current, { now: () => now,
    accountIdentity() { assert.fail('CLI must not start') },
    async fetcher(url, request) {
      calls.push({ url, request })
      if (url.endsWith('/auth/exchange_user_api_key')) {
        assert.equal(request.headers.authorization, 'Bearer own-key')
        return json({ accessToken: 'derived-access', refreshToken: 'unused-refresh' })
      }
      assert.equal(request.headers.authorization, 'Bearer derived-access')
      assert.equal(request.headers['Connect-Protocol-Version'], '1')
      return json({ ...shared, cursorPlanName: 'Premium' })
    },
  })
  assert.equal(result.windows[0].used_percent, 12.5)
  assert.equal(result.plan, 'Premium')
  assert.deepEqual(calls.map(call => call.url), ['https://api2.cursor.sh/auth/exchange_user_api_key',
    'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus'])
  assert.ok(calls.every(call => call.request.headers.cookie === undefined && call.request.body === '{}' && call.request.redirect === 'error'))
  assert.ok(!JSON.stringify(result).includes('derived-access'))
})

test('API-key quota rejects bad exchange, denied access, and non-unified pools without silent credential fallback', async () => {
  const current = provider('api-account')
  current.connection.extra = { cursor_api_key: 'own-key' }
  for (const exchange of [{}, { accessToken: 'bad\r\nheader' }]) {
    await assert.rejects(fetchSubscriptionUsage(current, { fetcher: async () => json(exchange) }), /access token/)
  }
  await assert.rejects(fetchSubscriptionUsage(current, { fetcher: async () => json({ secret: 'SENTINEL' }, 403) }),
    error => /rejected quota/.test(error.message) && !error.message.includes('SENTINEL'))
  await assert.rejects(fetchSubscriptionUsage(current, { fetcher: async url => json(url.includes('exchange')
    ? { accessToken: 'valid-access' } : { ...shared, isUnified: false }) }), /did not return an X shared pool/)
  await assert.rejects(fetchSubscriptionUsage(current, { timeoutMilliseconds: 20,
    fetcher: () => new Promise(() => {}),
  }), /timed out/)
})

test('CLI login uses the official panel without HTTP, cookie, fabricated reset or a shared-pool label', async () => {
  const current = provider()
  current.connection.extra = { auth_mode: 'cli_login' }
  const result = await fetchSubscriptionUsage(current, { now: () => now,
    fetcher() { assert.fail('HTTP called') }, accountIdentity() { assert.fail('identity called') },
    cliUsage: async signal => {
      assert.equal(signal.aborted, false)
      return { plan: 'Premium', used_percent: 23, reset_label: 'Resets Nov 2' }
    },
  })
  assert.equal(result.windows[0].id, 'cli-included')
  assert.equal(result.windows[0].used_percent, 23)
  assert.equal(result.windows[0].reset_at, undefined)
  assert.equal(result.windows[0].detail, 'Resets Nov 2 (UTC)')
  const withoutReset = await fetchSubscriptionUsage(current, { now: () => now,
    cliUsage: async () => ({ plan: 'Premium', used_percent: 23 }),
  })
  assert.equal(withoutReset.windows[0].detail, undefined)
  await assert.rejects(fetchSubscriptionUsage(current, { timeoutMilliseconds: 20,
    cliUsage: () => new Promise(() => {}),
  }), /timed out/)
})

test('body cancellation cannot leak transport errors or defeat the deadline', async () => {
  for (const status of [200, 401]) {
    const { options } = fixture({ '/api/auth/me': new Response(new ReadableStream({
      start(controller) { controller.error(new Error('SECRET_TRANSPORT_SENTINEL')) },
    }), { status, headers: { 'content-type': 'text/html' } }) })
    await assert.rejects(fetchSubscriptionUsage(provider(), options),
      error => error.statusCode && !error.message.includes('SECRET'))
  }
  for (const status of [200, 401]) {
    const { options } = fixture({ '/api/auth/me': new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
      cancel() { return new Promise(() => {}) },
    }), { status, headers: { 'content-type': 'application/json' } }) })
    await assert.rejects(fetchSubscriptionUsage(provider(), { ...options, timeoutMilliseconds: 20 }),
      /exceeds|expired/)
  }
})

test('credential rotation discards quota snapshots from the previous account generation', async () => {
  const { options } = fixture()
  let checks = 0
  await assert.rejects(fetchSubscriptionUsage(provider(), { ...options,
    assertCurrent() { if (++checks === 5) throw new Error('configuration changed') },
  }), /configuration changed/)
})
