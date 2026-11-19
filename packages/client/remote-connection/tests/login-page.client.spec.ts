// @vitest-environment jsdom
/** Anonymous login-page effects before the authenticated application loads. */
import { afterEach, expect, it, vi } from 'vitest'
import { enterAuthenticationPage, renderAuthenticationPage } from '../src/login-page.ts'
import type { AuthenticationPageOptions } from '../src/login-page.ts'
import { loginLocales } from '../src/login-locales.ts'

const TOKEN = 'a'.repeat(43)
const initialUrl = window.location.href

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  history.replaceState(null, '', initialUrl)
  document.documentElement.innerHTML = '<head></head><body></body>'
})

function page(path = `/?login=qr#${TOKEN}`, language = 'en-US') {
  const html = new DOMParser().parseFromString(renderAuthenticationPage({ tokenLoginEnabled: true }), 'text/html')
  document.documentElement.innerHTML = html.documentElement.innerHTML
  history.replaceState(null, '', path)
  const actualLocation = window.location
  const replace = vi.fn<Location['replace']>()
  vi.stubGlobal('location', {
    get href() { return actualLocation.href },
    replace,
  } satisfies Pick<Location, 'href' | 'replace'>)
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language)
  const exchange = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', exchange)
  return {
    exchange, replace, actualLocation,
    status: document.getElementById('status') as HTMLElement,
    notice: document.getElementById('qr-notice') as HTMLElement,
    form: document.getElementById('token-form') as HTMLFormElement,
    input: document.getElementById('token') as HTMLInputElement,
    error: document.getElementById('token-error') as HTMLElement,
    submit: document.getElementById('token-submit') as HTMLButtonElement,
  }
}

function authenticationPage(options: AuthenticationPageOptions = { tokenLoginEnabled: true }, language = 'en-US') {
  const html = new DOMParser().parseFromString(renderAuthenticationPage(options), 'text/html')
  document.documentElement.innerHTML = html.documentElement.innerHTML
  history.replaceState(null, '', '/mount/')
  const actualLocation = window.location
  const replace = vi.fn<Location['replace']>()
  vi.stubGlobal('location', {
    get href() { return actualLocation.href },
    replace,
  } satisfies Pick<Location, 'href' | 'replace'>)
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language)
  const exchange = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', exchange)
  return {
    exchange, replace, actualLocation,
    form: document.getElementById('token-form') as HTMLFormElement,
    input: document.getElementById('token') as HTMLInputElement,
    error: document.getElementById('token-error') as HTMLElement,
    submit: document.getElementById('token-submit') as HTMLButtonElement,
  }
}

it.each(['en-US', 'zh-CN'])('shows the anonymous Token form without Client boot data in %s', (language) => {
  const fixture = authenticationPage(undefined, language)
  enterAuthenticationPage(loginLocales)
  const t = language.startsWith('zh') ? loginLocales.zh : loginLocales.en
  expect(document.title).toBe(t.authenticationTitle)
  expect(document.getElementById('description')?.textContent).toBe(t.authenticationDescription)
  const title = document.getElementById('token-title')!
  const label = document.getElementById('token-label')!
  const hint = document.getElementById('token-hint')!
  expect(title.tagName).toBe('H2')
  expect(title.firstElementChild).toBe(label)
  expect(title.textContent).toBe(t.tokenLabel)
  expect(fixture.input.labels?.item(0)).toBe(label)
  expect(fixture.form.getAttribute('aria-labelledby')).toBe(title.id)
  expect(title.nextElementSibling).toBe(hint)
  expect(hint.textContent).toBe(t.tokenHint)
  expect(hint.nextElementSibling).toBe(fixture.input)
  expect(fixture.form.method).toBe('get')
  expect(fixture.form.action).toBe(new URL('/mount/', fixture.actualLocation.href).href)
  expect(fixture.input.type).toBe('password')
  expect(fixture.input.placeholder).toBe(`${fixture.actualLocation.origin}/mount/?token=xxx`)
  expect(fixture.input.required).toBe(true)
  expect(fixture.input.getAttribute('aria-describedby')).toBe('token-hint token-error')
  expect(fixture.submit.textContent).toBe(t.tokenSubmit)
  expect(document.documentElement.innerHTML).not.toContain('__DSH_BOOT__')
  expect(document.documentElement.innerHTML).not.toContain('authPages')
  expect((document.getElementById('qr-notice') as HTMLElement).hidden).toBe(true)
  expect(document.getElementById('status')?.textContent).toBe('')
  expect((document.getElementById('open') as HTMLAnchorElement).hidden).toBe(true)
  expect(fixture.exchange).not.toHaveBeenCalled()
})

it.each([
  'http://192.168.1.8:3080/',
  'http://[2001:db8::1]:3080/',
  'https://host.example:9443/tools/dsh/',
  'https://host.example:9443/tools/$&/$$/',
])('shows %s without page credentials, query values, or fragments in the placeholder', (applicationUrl) => {
  const fixture = authenticationPage()
  vi.stubGlobal('location', {
    href: `${applicationUrl}?token=${TOKEN}&hint=private-query#private-fragment`,
    replace: fixture.replace,
  } satisfies Pick<Location, 'href' | 'replace'>)
  vi.spyOn(history, 'replaceState').mockImplementation(() => {})
  enterAuthenticationPage(loginLocales, vi.fn())
  expect(fixture.input.placeholder).toBe(`${applicationUrl}?token=xxx`)
  expect(fixture.input.placeholder).not.toContain(TOKEN)
  expect(fixture.input.placeholder).not.toContain('private-query')
  expect(fixture.input.placeholder).not.toContain('private-fragment')
})

it('hides the Token form when its provider is unavailable', () => {
  const fixture = authenticationPage({ tokenLoginEnabled: false }, 'zh-CN')
  enterAuthenticationPage(loginLocales)
  expect(document.getElementById('description')?.textContent).toBe(loginLocales.zh.authenticationUnavailable)
  expect(document.getElementById('token-form')).toBeNull()
  expect(fixture.exchange).not.toHaveBeenCalled()
})

it('clears a Token from the address and clears submission feedback on edit', async () => {
  const fixture = authenticationPage(undefined, 'zh-CN')
  history.replaceState(null, '', `/mount/?token=${TOKEN}&keep=value`)
  fixture.exchange.mockResolvedValue(new Response(null, { status: 401 }))
  enterAuthenticationPage(loginLocales)
  expect(fixture.actualLocation.href).not.toContain(TOKEN)
  expect(fixture.actualLocation.search).toBe('?keep=value')
  expect(fixture.error.textContent).toBe('')
  expect(fixture.input.hasAttribute('aria-invalid')).toBe(false)
  fixture.input.value = TOKEN
  fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))
  await expect.poll(() => fixture.error.textContent).toBe(loginLocales.zh.tokenInvalid)
  await expect.poll(() => fixture.submit.disabled).toBe(false)
  expect(fixture.input.getAttribute('aria-invalid')).toBe('true')
  expect(fixture.input.previousElementSibling?.textContent).toBe(loginLocales.zh.tokenHint)
  expect(fixture.input.nextElementSibling).toBe(fixture.error)
  fixture.input.dispatchEvent(new Event('input'))
  expect(fixture.error.textContent).toBe('')
  expect(fixture.input.hasAttribute('aria-invalid')).toBe(false)
})

it.each(['short', `https://elsewhere.example/?token=${TOKEN}&token=${TOKEN}`, `https://elsewhere.example/?other=${TOKEN}`])('rejects an invalid Token or link without sending it: %s', (value) => {
  const fixture = authenticationPage()
  enterAuthenticationPage(loginLocales)
  fixture.input.value = value
  expect(fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))).toBe(false)
  expect(fixture.error.textContent).toBe(loginLocales.en.tokenInvalid)
  expect(fixture.input.getAttribute('aria-invalid')).toBe('true')
  expect(fixture.exchange).not.toHaveBeenCalled()
  expect(fixture.replace).not.toHaveBeenCalled()
})

it.each([TOKEN, ` https://elsewhere.example/path?token=${TOKEN} `])('uses only the Token from the submitted value at the current application mount', async (value) => {
  const fixture = authenticationPage()
  const pending = Promise.withResolvers<Response>()
  fixture.exchange.mockReturnValue(pending.promise)
  enterAuthenticationPage(loginLocales)
  fixture.input.value = value
  fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))
  const [target, init] = fixture.exchange.mock.calls[0]!
  expect(target).toBe(new URL(`/mount/?token=${TOKEN}`, fixture.actualLocation.href).href)
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'follow' })
  expect(init?.signal).toBeInstanceOf(AbortSignal)
  expect(fixture.submit.disabled).toBe(true)
  expect(fixture.submit.textContent).toBe(loginLocales.en.tokenPending)
  expect(fixture.form.getAttribute('aria-busy')).toBe('true')
  fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))
  expect(fixture.exchange).toHaveBeenCalledTimes(1)
  pending.resolve(new Response(null, { status: 200 }))
  await expect.poll(() => fixture.replace.mock.calls).toEqual([['./']])
  await expect.poll(() => fixture.submit.disabled).toBe(false)
  expect(fixture.actualLocation.href).not.toContain(TOKEN)
})

it.each([401, 403, 503])('keeps HTTP %i on the anonymous page and allows another submission', async (status) => {
  const fixture = authenticationPage(undefined, 'zh-CN')
  fixture.exchange.mockResolvedValue(new Response(null, { status }))
  enterAuthenticationPage(loginLocales)
  fixture.input.value = TOKEN
  fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))
  await expect.poll(() => fixture.error.textContent).toBe(status === 401 ? loginLocales.zh.tokenInvalid : loginLocales.zh.tokenFailed)
  await expect.poll(() => fixture.submit.disabled).toBe(false)
  expect(fixture.input.getAttribute('aria-invalid')).toBe(status === 401 ? 'true' : null)
  expect(fixture.replace).not.toHaveBeenCalled()
  fixture.exchange.mockResolvedValue(new Response(null, { status: 200 }))
  fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))
  await expect.poll(() => fixture.replace.mock.calls).toEqual([['./']])
})

it('reports a failed Token request without automatically replaying it', async () => {
  const fixture = authenticationPage()
  fixture.exchange.mockRejectedValue(new TypeError('connection closed'))
  enterAuthenticationPage(loginLocales)
  fixture.input.value = TOKEN
  fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))
  await expect.poll(() => fixture.error.textContent).toBe(loginLocales.en.tokenFailed)
  expect(fixture.exchange).toHaveBeenCalledTimes(1)
  expect(fixture.replace).not.toHaveBeenCalled()
})

it('aborts each in-flight Token request when the page leaves, including after a previous failure', async () => {
  const fixture = authenticationPage()
  fixture.exchange.mockResolvedValueOnce(new Response(null, { status: 401 }))
  enterAuthenticationPage(loginLocales)
  fixture.input.value = TOKEN
  fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))
  await expect.poll(() => fixture.submit.disabled).toBe(false)
  let signal: AbortSignal | undefined
  fixture.exchange.mockImplementation((_target, init) => new Promise<Response>((_resolve, reject) => {
    signal = init?.signal ?? undefined
    signal?.addEventListener('abort', () => { reject(new DOMException('page hidden', 'AbortError')) }, { once: true })
  }))
  fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))
  expect(signal?.aborted).toBe(false)
  window.dispatchEvent(new Event('pagehide'))
  expect(signal?.aborted).toBe(true)
  await expect.poll(() => fixture.submit.disabled).toBe(false)
  expect(fixture.error.textContent).toBe('')
  expect(fixture.replace).not.toHaveBeenCalled()
})

it('does not navigate when a completed Token request settles after the page leaves', async () => {
  const fixture = authenticationPage()
  const pending = Promise.withResolvers<Response>()
  fixture.exchange.mockReturnValue(pending.promise)
  enterAuthenticationPage(loginLocales)
  fixture.input.value = TOKEN
  fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))
  const signal = fixture.exchange.mock.calls[0]![1]?.signal
  expect(signal?.aborted).toBe(false)
  pending.resolve(new Response(null, { status: 200 }))
  window.dispatchEvent(new Event('pagehide'))
  expect(signal?.aborted).toBe(true)
  await expect.poll(() => fixture.submit.disabled).toBe(false)
  expect(fixture.form.hasAttribute('aria-busy')).toBe(false)
  expect(fixture.error.textContent).toBe('')
  expect(fixture.replace).not.toHaveBeenCalled()
})

it.each(['', '#short', `#${'a'.repeat(42)}!`])('removes an invalid fragment without sending a login request: %s', (fragment) => {
  const fixture = page(`/?login=qr${fragment}`)
  enterAuthenticationPage(loginLocales)
  expect(fixture.actualLocation.hash).toBe('')
  expect(fixture.actualLocation.search).toBe('')
  expect(fixture.status.textContent).toBe(loginLocales.en.invalid)
  expect(fixture.exchange).not.toHaveBeenCalled()
  expect(fixture.replace).not.toHaveBeenCalled()
})

it('clears the credential before POST and keeps the mount prefix when opening the authenticated app', async () => {
  const fixture = page(`/mount/?login=qr&token=unrelated&other=value#${TOKEN}`, 'ZH-cn')
  const pending = Promise.withResolvers<Response>()
  fixture.exchange.mockImplementation((input, init) => {
    expect(fixture.actualLocation.href).not.toContain(TOKEN)
    expect(input).toBe('/mount/?login=qr')
    expect(fixture.actualLocation.search).toBe('')
    expect(init).toMatchObject({
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'text/plain' }, body: TOKEN,
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    return pending.promise
  })
  enterAuthenticationPage(loginLocales)
  expect(document.documentElement.lang).toBe('zh')
  expect(document.title).toBe(loginLocales.zh.authenticationTitle)
  expect(document.getElementById('title')?.textContent).toBe(loginLocales.zh.authenticationTitle)
  expect(document.getElementById('open')?.textContent).toBe(loginLocales.zh.open)
  expect(fixture.status.textContent).toBe(loginLocales.zh.pending)
  expect(fixture.replace).not.toHaveBeenCalled()
  pending.resolve(new Response(null, { status: 204 }))
  await expect.poll(() => fixture.replace.mock.calls).toEqual([['./']])
  expect(new URL(fixture.replace.mock.calls[0]![0], fixture.actualLocation.href).pathname).toBe('/mount/')
})

it.each([410, 403, 503, 500])('reports HTTP %i without claiming login or redirecting', async (status) => {
  const fixture = page(undefined, 'fr-FR')
  fixture.exchange.mockResolvedValue(new Response(null, { status }))
  enterAuthenticationPage(loginLocales)
  const message = status === 410 ? loginLocales.en.invalid
    : status === 403 ? loginLocales.en.forbidden
      : status === 503 ? loginLocales.en.unavailable : loginLocales.en.failed
  await expect.poll(() => fixture.status.textContent).toBe(message)
  expect(fixture.status.getAttribute('role')).toBe('alert')
  expect(fixture.notice.hidden).toBe(false)
  expect(fixture.form).not.toBeNull()
  expect(fixture.submit.disabled).toBe(false)
  expect(document.title).toBe(loginLocales.en.authenticationTitle)
  expect(document.documentElement.lang).toBe('en')
  expect(fixture.replace).not.toHaveBeenCalled()
  expect(fixture.actualLocation.hash).toBe('')
  expect(document.getElementById('open')?.getAttribute('href')).toBe('./')
})

it('reports a lost response as an unknown outcome and keeps the app recovery link', async () => {
  const fixture = page()
  fixture.exchange.mockRejectedValue(new TypeError('connection closed'))
  enterAuthenticationPage(loginLocales)
  await expect.poll(() => fixture.status.textContent).toBe(loginLocales.en.networkFailed)
  expect(fixture.replace).not.toHaveBeenCalled()
  expect(document.getElementById('open')?.getAttribute('href')).toBe('./')
  expect(fixture.actualLocation.href).not.toContain(TOKEN)
})

it('aborts the owned exchange when the browser leaves the page', async () => {
  const fixture = page()
  let signal: AbortSignal | undefined
  fixture.exchange.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
    signal = init?.signal ?? undefined
    signal?.addEventListener('abort', () => { reject(new DOMException('page hidden', 'AbortError')) }, { once: true })
  }))
  enterAuthenticationPage(loginLocales)
  expect(signal?.aborted).toBe(false)
  window.dispatchEvent(new Event('pagehide'))
  expect(signal?.aborted).toBe(true)
  await expect(fixture.exchange.mock.results[0]?.value).rejects.toMatchObject({ name: 'AbortError' })
  expect(fixture.status.textContent).toBe(loginLocales.en.pending)
  expect(fixture.replace).not.toHaveBeenCalled()
})

it('does not navigate when a completed QR request settles after the page leaves', async () => {
  const fixture = page()
  const pending = Promise.withResolvers<Response>()
  fixture.exchange.mockReturnValue(pending.promise)
  enterAuthenticationPage(loginLocales)
  const signal = fixture.exchange.mock.calls[0]![1]?.signal
  expect(signal?.aborted).toBe(false)
  pending.resolve(new Response(null, { status: 204 }))
  window.dispatchEvent(new Event('pagehide'))
  expect(signal?.aborted).toBe(true)
  await pending.promise
  expect(fixture.status.textContent).toBe(loginLocales.en.pending)
  expect(fixture.replace).not.toHaveBeenCalled()
})

it('exchanges QR credentials while retaining the ordinary page when Token sign-in is unavailable', async () => {
  const fixture = authenticationPage({ tokenLoginEnabled: false })
  history.replaceState(null, '', `/mount/?login=qr#${TOKEN}`)
  fixture.exchange.mockResolvedValue(new Response(null, { status: 204 }))
  enterAuthenticationPage(loginLocales)
  expect(document.getElementById('title')?.textContent).toBe(loginLocales.en.authenticationTitle)
  expect(document.getElementById('description')?.textContent).toBe(loginLocales.en.authenticationUnavailable)
  expect(document.getElementById('token-form')).toBeNull()
  expect(document.getElementById('status')?.textContent).toBe(loginLocales.en.pending)
  await expect.poll(() => fixture.replace.mock.calls).toEqual([['./']])
})

it('keeps QR errors visible while Token sign-in remains available and handles its own failure', async () => {
  const fixture = page(undefined, 'zh-CN')
  fixture.exchange.mockResolvedValueOnce(new Response(null, { status: 410 }))
  enterAuthenticationPage(loginLocales)
  await expect.poll(() => fixture.status.textContent).toBe(loginLocales.zh.invalid)
  expect(fixture.form.hidden).toBe(false)
  expect(fixture.submit.disabled).toBe(false)
  fixture.exchange.mockResolvedValueOnce(new Response(null, { status: 401 }))
  fixture.input.value = TOKEN
  fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))
  await expect.poll(() => fixture.error.textContent).toBe(loginLocales.zh.tokenInvalid)
  await expect.poll(() => fixture.submit.disabled).toBe(false)
  expect(fixture.status.textContent).toBe(loginLocales.zh.invalid)
  expect(fixture.status.getAttribute('role')).toBe('alert')
  fixture.exchange.mockResolvedValueOnce(new Response(null, { status: 200 }))
  fixture.input.dispatchEvent(new Event('input'))
  expect(fixture.error.textContent).toBe('')
  expect(fixture.status.textContent).toBe(loginLocales.zh.invalid)
  fixture.form.dispatchEvent(new Event('submit', { cancelable: true }))
  await expect.poll(() => fixture.replace.mock.calls).toEqual([['./']])
  expect(fixture.exchange.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET', 'GET'])
  expect(fixture.status.textContent).toBe(loginLocales.zh.invalid)
})

it('automatically exchanges a fragment at the ordinary root without a QR query parameter', async () => {
  const fixture = page(`/mount/#${TOKEN}`)
  enterAuthenticationPage(loginLocales)
  expect(fixture.actualLocation.pathname).toBe('/mount/')
  expect(fixture.actualLocation.hash).toBe('')
  expect(fixture.exchange.mock.calls[0]?.[0]).toBe('/mount/?login=qr')
  expect(document.title).toBe(loginLocales.en.authenticationTitle)
  await expect.poll(() => fixture.replace.mock.calls).toEqual([['./']])
})

it('escapes embedded localized text before serializing the anonymous script', () => {
  const copy = { ...loginLocales, en: { ...loginLocales.en, failed: '</script><img src=x>' } }
  vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => JSON.stringify(copy))
  const html = renderAuthenticationPage({ tokenLoginEnabled: true })
  expect(html).not.toContain('</script><img src=x>')
  expect(html).toContain('\\u003c/script>\\u003cimg src=x>')
  expect(html).toContain('name="referrer" content="no-referrer"')
  expect(html).toContain('id="qr-notice" class="notice" hidden')
  expect(html).toContain('id="token-form"')
  const document = new DOMParser().parseFromString(html, 'text/html')
  expect(document.querySelector<HTMLInputElement>('#token')?.placeholder).toBe(
    loginLocales.en.tokenPlaceholder.replace('{url}', loginLocales.en.tokenPlaceholderFallbackUrl),
  )
})

it.each(['en-US', 'zh-CN'])('keeps device pairing available without the Token provider in %s', (language) => {
  const fixture = authenticationPage({ tokenLoginEnabled: false, pairingEnabled: true }, language)
  enterAuthenticationPage(loginLocales)
  const t = language.startsWith('zh') ? loginLocales.zh : loginLocales.en
  expect(document.getElementById('description')?.textContent).toBe(t.authenticationDescription)
  expect(document.getElementById('token-form')).toBeNull()
  expect(document.querySelectorAll('dsh-device-pairing')).toHaveLength(1)
  const script = document.querySelector<HTMLScriptElement>('script[src]')!
  expect(script.getAttribute('src')).toBe('./pairing/client.js')
  expect(script.defer).toBe(true)
  expect(document.documentElement.innerHTML).not.toContain('__DSH_BOOT__')
  expect(document.documentElement.innerHTML).not.toContain('authPages')
  expect(fixture.exchange).not.toHaveBeenCalled()
})

it('renders the Token form and pairing as separate sign-in actions in the same document', () => {
  const fixture = authenticationPage({ tokenLoginEnabled: true, pairingEnabled: true })
  enterAuthenticationPage(loginLocales)
  expect(fixture.form.querySelector('dsh-device-pairing')).toBeNull()
  expect(fixture.form.nextElementSibling?.tagName).toBe('DSH-DEVICE-PAIRING')
  expect(document.querySelectorAll('script[src]')).toHaveLength(1)
  expect(renderAuthenticationPage({ tokenLoginEnabled: true, pairingEnabled: true }))
    .toContain(`<dsh-device-pairing><noscript><p>${loginLocales.en.pairingScriptRequired}</p></noscript></dsh-device-pairing>`)
})



it.each([
  { methods: 'Token and pairing', tokenLoginEnabled: true, pairingEnabled: true, count: 2 },
  { methods: 'Token only', tokenLoginEnabled: true, pairingEnabled: false, count: 1 },
  { methods: 'pairing only', tokenLoginEnabled: false, pairingEnabled: true, count: 1 },
])('renders $methods below the shared heading and QR feedback', ({ tokenLoginEnabled, pairingEnabled, count }) => {
  authenticationPage({ tokenLoginEnabled, pairingEnabled })
  const methods = document.querySelector('.methods')!
  expect(methods.children).toHaveLength(count)
  expect(document.getElementById('token-form')?.parentElement).toBe(tokenLoginEnabled ? methods : undefined)
  expect(document.querySelector('dsh-device-pairing')?.parentElement).toBe(pairingEnabled ? methods : undefined)
  expect(document.getElementById('title')?.parentElement).toBe(methods.parentElement)
  expect(document.getElementById('description')?.parentElement).toBe(methods.parentElement)
  expect(document.getElementById('qr-notice')?.parentElement).toBe(methods.parentElement)
})
