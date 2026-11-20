/** Remote-owned anonymous login document, without Client boot data. */
import { loginLocales } from './login-locales.ts'

/** Public capabilities shown by the anonymous login page. */
export interface AuthenticationPageOptions {
  /** Whether the default Token provider has published its login entry. */
  readonly tokenLoginEnabled: boolean
  /** Whether the Remote provider accepts device-pairing requests. */
  readonly pairingEnabled?: boolean
}

const pageStyle = `
:root{color-scheme:light dark;font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;background:light-dark(#fafafa,#171717);color:light-dark(#222,#eee)}
body{margin:0;min-height:100dvh}
.page{display:flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:100dvh;padding:max(24px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
.card{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;min-width:0;width:100%;max-width:360px}
.methods{display:grid;gap:24px}
.card:not(:has(.methods)),.methods>*{box-sizing:border-box;min-width:0;padding:24px;border:.5px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:var(--dsw-radius-lg,12px);background:light-dark(#fff,#232324)}
h1{margin:0;font-size:20px;line-height:1.3;font-weight:500}
p{margin:0;font-size:14px;line-height:1.5;overflow-wrap:anywhere}
.description,.hint{color:color-mix(in srgb,currentColor 72%,transparent)}
form{display:flex;flex-direction:column;gap:12px;min-width:0}
form h2{margin:0;font-size:14px;line-height:1.5;font-weight:500}
form label{font:inherit;color:inherit}
input,button{box-sizing:border-box;min-width:0;min-height:44px;padding:8px 12px;font:inherit;font-size:14px;line-height:1.5;border-radius:8px}
input{width:100%;line-height:22px;color:inherit;background:light-dark(#fafafa,#1b1b1c);border:.5px solid color-mix(in srgb,currentColor 16%,transparent);outline:none}
input::placeholder{color:var(--dsw-alias-label-caption,light-dark(#adb2b8,#81858c));opacity:1}
input:focus{border-color:var(--dsw-alias-state-business-primary,light-dark(#4176e6,#7aaaff))}
input[aria-invalid='true']{border:1px solid light-dark(#ec1313,#f25a5a)}
.error{font-size:13px;line-height:1.5;color:light-dark(#ec1313,#f25a5a)}
.error:empty{display:none}
.notice{display:flex;flex-direction:column;gap:8px;padding:12px;border:.5px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:8px;background:light-dark(#f5f5f5,#2a2a2b)}
.notice[hidden]{display:none}
.notice[data-state="error"]{color:light-dark(#a10c0c,#ffb3b3);border-color:light-dark(#f5b5b5,#8c3030);background:light-dark(#fff3f3,#381e1e)}
.notice a{padding:0;font-size:13px}
button{cursor:pointer;font-weight:500;color:light-dark(#fff,#222);background:light-dark(#222,#eee);border:0}
button:disabled{cursor:wait;opacity:.6}
a{color:inherit;text-underline-offset:3px;padding:8px 0;font-size:14px;line-height:1.5}
button:focus-visible,a:focus-visible{outline:2px solid currentColor;outline-offset:2px}
@media(hover:hover){button:not(:disabled):hover{background:light-dark(#3c3c3d,#d4d4d4)}}
@media(pointer:coarse){input{font-size:16px;line-height:24px}}
`

function scriptJson(value: typeof loginLocales): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function documentHtml(title: string, content: string, script: string, pairingEnabled = false): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${title}</title><style>${pageStyle}</style></head><body><main class="page"><section class="card" aria-labelledby="title">${content}</section></main><script>${script}</script>${pairingEnabled ? '<script defer src="./pairing/client.js"></script>' : ''}</body></html>`
}

/**
 * Submit a Token through its own HTTP exchange without starting Client plugins.
 * Failed submissions remain on this page; page departure cancels an in-flight request.
 * @param locales - public copy embedded beside the entry.
 * @param exchangeQr - QR exchange initializer embedded with this function; defaults to the root-entry handler.
 */
export function enterAuthenticationPage(
  locales: typeof loginLocales,
  exchangeQr: (locales: typeof loginLocales) => void = enterBrowser,
): void {
  const language = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const t = locales[language]
  document.documentElement.lang = language
  document.title = t.authenticationTitle
  const title = document.getElementById('title') as HTMLElement
  title.textContent = t.authenticationTitle
  const form = document.getElementById('token-form') as HTMLFormElement | null
  const description = document.getElementById('description') as HTMLElement
  description.textContent = form === null && document.querySelector('dsh-device-pairing') === null
    ? t.authenticationUnavailable : t.authenticationDescription
  const clean = new URL(location.href)
  clean.searchParams.delete('token')
  history.replaceState(null, '', clean)
  if (form !== null) {
    const input = document.getElementById('token') as HTMLInputElement
    const error = document.getElementById('token-error') as HTMLElement
    const submit = document.getElementById('token-submit') as HTMLButtonElement
    const label = document.getElementById('token-label') as HTMLElement
    const hint = document.getElementById('token-hint') as HTMLElement
    label.textContent = t.tokenLabel
    input.placeholder = t.tokenPlaceholder.replace('{url}', () => `${clean.origin}${clean.pathname}`)
    hint.textContent = t.tokenHint
    submit.textContent = t.tokenSubmit
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid')
      error.textContent = ''
    })
    let pending: AbortController | undefined
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (pending !== undefined) return
      let token = input.value.trim()
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        try {
          const values = new URL(token).searchParams.getAll('token')
          token = values.length === 1 ? values.join('') : ''
        } catch (_invalidUrl) {
          // A pasted value that is neither a Token nor a URL cannot start an exchange.
          token = ''
        }
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        error.textContent = t.tokenInvalid
        input.setAttribute('aria-invalid', 'true')
        return
      }
      const target = new URL(form.action)
      target.searchParams.set('token', token)
      const lifetime = new AbortController()
      const abort = lifetime.abort.bind(lifetime, undefined)
      window.addEventListener('pagehide', abort, { once: true })
      pending = lifetime
      submit.disabled = true
      submit.textContent = t.tokenPending
      form.setAttribute('aria-busy', 'true')
      error.textContent = ''
      input.removeAttribute('aria-invalid')
      void fetch(target.href, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'follow', signal: lifetime.signal,
      }).then((response) => {
        if (lifetime.signal.aborted) return
        if (response.status === 200) location.replace('./')
        else {
          error.textContent = response.status === 401 ? t.tokenInvalid : t.tokenFailed
          if (response.status === 401) input.setAttribute('aria-invalid', 'true')
        }
      }).catch(() => {
        if (!lifetime.signal.aborted) error.textContent = t.tokenFailed
      }).finally(() => {
        window.removeEventListener('pagehide', abort)
        pending = undefined
        submit.disabled = false
        submit.textContent = t.tokenSubmit
        form.removeAttribute('aria-busy')
      })
    })
  }
  exchangeQr(locales)
}

/**
 * Render Remote's root login page, without a Token value or private boot data.
 * @param options - Token login and device-pairing availability.
 * @returns sign-in cards with titles and descriptions above controls, below the shared heading and QR feedback.
 */
export function renderAuthenticationPage(options: AuthenticationPageOptions): string {
  const t = loginLocales.en
  const placeholder = t.tokenPlaceholder.replace('{url}', t.tokenPlaceholderFallbackUrl)
  const tokenForm = options.tokenLoginEnabled ? `<form id="token-form" action="./" method="get" aria-labelledby="token-title"><h2 id="token-title"><label id="token-label" for="token">${t.tokenLabel}</label></h2><p id="token-hint" class="hint">${t.tokenHint}</p><input id="token" type="password" name="token" placeholder="${placeholder}" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-describedby="token-hint token-error"><p id="token-error" class="error" role="alert"></p><button id="token-submit" type="submit">${t.tokenSubmit}</button></form>` : ''
  const pairing = options.pairingEnabled
    ? `<dsh-device-pairing><noscript><p>${t.pairingScriptRequired}</p></noscript></dsh-device-pairing>` : ''
  const methods = tokenForm || pairing ? `<div class="methods">${tokenForm}${pairing}</div>` : ''
  const content = `<h1 id="title">${t.authenticationTitle}</h1><p id="description" class="description">${options.tokenLoginEnabled || options.pairingEnabled ? t.authenticationDescription : t.authenticationUnavailable}</p><div id="qr-notice" class="notice" hidden><p id="status" role="status"></p><a id="open" href="./" hidden>${t.open}</a></div>${methods}`
  return documentHtml(t.authenticationTitle, content, `(${enterAuthenticationPage.toString()})(${scriptJson(loginLocales)},(${enterBrowser.toString()}))`, options.pairingEnabled)
}

/**
 * Exchange an invitation fragment while retaining the ordinary sign-in choices.
 * @param locales - copy embedded with the root-page initializer.
 */
export function enterBrowser(locales: typeof loginLocales): void {
  const current = new URL(location.href)
  const token = current.hash.slice(1)
  if (current.searchParams.get('login') !== 'qr' && token.length === 0) return
  const clean = new URL(current.pathname, current)
  history.replaceState(null, '', clean)
  const target = new URL(clean)
  target.searchParams.set('login', 'qr')
  const t = locales[document.documentElement.lang === 'zh' ? 'zh' : 'en']
  const notice = document.getElementById('qr-notice') as HTMLElement
  const status = document.getElementById('status') as HTMLElement
  const open = document.getElementById('open') as HTMLAnchorElement
  notice.hidden = false
  open.textContent = t.open
  const showError = (message: string, checkApp = false): void => {
    status.textContent = message
    status.setAttribute('role', 'alert')
    notice.dataset.state = 'error'
    open.hidden = !checkApp
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    showError(t.invalid)
    return
  }
  status.textContent = t.pending
  const lifetime = new AbortController()
  const abort = lifetime.abort.bind(lifetime, undefined)
  window.addEventListener('pagehide', abort, { once: true })
  void fetch(`${target.pathname}${target.search}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { 'content-type': 'text/plain' },
    body: token,
    signal: lifetime.signal,
  }).then((response) => {
    if (lifetime.signal.aborted) return
    switch (response.status) {
      case 204: location.replace('./'); break
      case 410: showError(t.invalid); break
      case 403: showError(t.forbidden); break
      case 503: showError(t.unavailable); break
      default: showError(t.failed)
    }
  }).catch(() => {
    // A lost response may follow a successful single-use exchange; the app link checks that outcome.
    if (!lifetime.signal.aborted) showError(t.networkFailed, true)
  }).finally(() => { window.removeEventListener('pagehide', abort) })
}
