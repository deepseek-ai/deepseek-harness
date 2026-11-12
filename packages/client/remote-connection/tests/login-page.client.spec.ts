// @vitest-environment jsdom
/** Anonymous login-page effects before the authenticated application loads. */
import { afterEach, expect, it, vi } from 'vitest'
import { enterAuthenticationPage, enterBrowser, renderAuthenticationPage, renderLoginPage } from '../src/login-page.ts'
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

function page(path = `/remote-login#${TOKEN}`, language = 'en-US') {
  const html = new DOMParser().parseFromString(renderLoginPage(), 'text/html')
  document.documentElement.innerHTML = html.documentElement.innerHTML
  history.replaceState(null, '', path)
  const actualLocation = window.location
  const replace = vi.fn<Location['replace']>()
  vi.stubGlobal('location', {
    get hash() { return actualLocation.hash },
    get pathname() { return actualLocation.pathname },
    replace,
  } satisfies Pick<Location, 'hash' | 'pathname' | 'replace'>)
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language)
  const exchange = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', exchange)
  return {
    exchange, replace, actualLocation,
    status: document.getElementById('status') as HTMLElement,
  }
}

function authenticationPage(options = { tokenLoginEnabled: true, tokenRejected: false }, language = 'en-US') {
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
  expect(document.getElementById('token-label')?.textContent).toBe(t.tokenLabel)
  expect(document.getElementById('token-hint')?.textContent).toBe(t.tokenHint)
  expect(fixture.form.method).toBe('get')
  expect(fixture.form.action).toBe(new URL('/mount/', fixture.actualLocation.href).href)
  expect(fixture.input.type).toBe('password')
  expect(fixture.input.required).toBe(true)
  expect(fixture.input.getAttribute('aria-describedby')).toBe('token-hint token-error')
  expect(fixture.submit.textContent).toBe(t.tokenSubmit)
  expect(document.documentElement.innerHTML).not.toContain('__DSH_BOOT__')
  expect(document.documentElement.innerHTML).not.toContain('authPages')
  expect(fixture.exchange).not.toHaveBeenCalled()
})

it('hides the Token form when its provider is unavailable', () => {
  const fixture = authenticationPage({ tokenLoginEnabled: false, tokenRejected: false }, 'zh-CN')
  enterAuthenticationPage(loginLocales)
  expect(document.getElementById('description')?.textContent).toBe(loginLocales.zh.authenticationUnavailable)
  expect(document.getElementById('token-form')).toBeNull()
  expect(fixture.exchange).not.toHaveBeenCalled()
})

it('removes a rejected Token from the address and keeps localized field feedback', () => {
  const fixture = authenticationPage({ tokenLoginEnabled: true, tokenRejected: true }, 'zh-CN')
  history.replaceState(null, '', `/mount/?token=${TOKEN}&keep=value`)
  enterAuthenticationPage(loginLocales, true)
  expect(fixture.actualLocation.href).not.toContain(TOKEN)
  expect(fixture.actualLocation.search).toBe('?keep=value')
  expect(fixture.error.textContent).toBe(loginLocales.zh.tokenInvalid)
  expect(fixture.input.getAttribute('aria-invalid')).toBe('true')
  fixture.input.value = TOKEN
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
  const fixture = page(`/remote-login${fragment}`)
  enterBrowser(loginLocales)
  expect(fixture.actualLocation.hash).toBe('')
  expect(fixture.status.textContent).toBe(loginLocales.en.invalid)
  expect(fixture.exchange).not.toHaveBeenCalled()
  expect(fixture.replace).not.toHaveBeenCalled()
})

it('clears the credential before POST and keeps the mount prefix when opening the authenticated app', async () => {
  const fixture = page(`/mount/remote-login#${TOKEN}`, 'ZH-cn')
  const pending = Promise.withResolvers<Response>()
  fixture.exchange.mockImplementation((input, init) => {
    expect(fixture.actualLocation.href).not.toContain(TOKEN)
    expect(input).toBe('/mount/remote-login')
    expect(init).toMatchObject({
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'text/plain' }, body: TOKEN,
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    return pending.promise
  })
  enterBrowser(loginLocales)
  expect(document.documentElement.lang).toBe('zh')
  expect(document.title).toBe(loginLocales.zh.title)
  expect(document.getElementById('title')?.textContent).toBe(loginLocales.zh.title)
  expect(document.getElementById('open')?.textContent).toBe(loginLocales.zh.open)
  expect(fixture.status.textContent).toBe(loginLocales.zh.pending)
  expect(fixture.replace).not.toHaveBeenCalled()
  pending.resolve(new Response(null, { status: 204 }))
  await expect.poll(() => fixture.replace.mock.calls).toEqual([['./']])
  expect(new URL(fixture.replace.mock.calls[0]![0], fixture.actualLocation.href).pathname).toBe('/mount/')
})

it.each([410, 403, 500])('reports HTTP %i without claiming login or redirecting', async (status) => {
  const fixture = page(undefined, 'fr-FR')
  fixture.exchange.mockResolvedValue(new Response(null, { status }))
  enterBrowser(loginLocales)
  await expect.poll(() => fixture.status.textContent).toBe(status === 410 ? loginLocales.en.invalid : loginLocales.en.failed)
  expect(document.documentElement.lang).toBe('en')
  expect(fixture.replace).not.toHaveBeenCalled()
  expect(fixture.actualLocation.hash).toBe('')
  expect(document.getElementById('open')?.getAttribute('href')).toBe('./')
})

it('reports a lost response as an unknown outcome and keeps the app recovery link', async () => {
  const fixture = page()
  fixture.exchange.mockRejectedValue(new TypeError('connection closed'))
  enterBrowser(loginLocales)
  await expect.poll(() => fixture.status.textContent).toBe(loginLocales.en.failed)
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
  enterBrowser(loginLocales)
  expect(signal?.aborted).toBe(false)
  window.dispatchEvent(new Event('pagehide'))
  expect(signal?.aborted).toBe(true)
  await expect.poll(() => fixture.status.textContent).toBe(loginLocales.en.failed)
  expect(fixture.replace).not.toHaveBeenCalled()
})

it('escapes embedded localized text before serializing the anonymous script', () => {
  const copy = { ...loginLocales, en: { ...loginLocales.en, failed: '</script><img src=x>' } }
  vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => JSON.stringify(copy))
  const html = renderLoginPage()
  expect(html).not.toContain('</script><img src=x>')
  expect(html).toContain('\\u003c/script>\\u003cimg src=x>')
  expect(html).toContain('name="referrer" content="no-referrer"')
  expect(html).toContain(`<noscript><p>${loginLocales.en.scriptRequired}</p></noscript>`)
})
