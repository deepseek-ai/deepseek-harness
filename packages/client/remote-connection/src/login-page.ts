/** Remote-owned anonymous login document, without Client boot data. */
import { loginLocales } from './login-locales.ts'

/** Public capabilities and rejection feedback shown by the anonymous login page. */
export interface AuthenticationPageOptions {
  /** Whether the default Token provider has published its login entry. */
  readonly tokenLoginEnabled: boolean
  /** Whether the root entry exchanges a QR invitation instead of showing sign-in choices; defaults to false. */
  readonly qrLogin?: boolean
  /** Whether this document follows a rejected Token submission. */
  readonly tokenRejected?: boolean
}

const pageStyle = `
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:light-dark(#fafafa,#171717);color:light-dark(#222,#eee)}
body{margin:0;min-height:100dvh}
.page{display:flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:100dvh;padding:max(24px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
.card{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;min-width:0;width:100%;max-width:360px;padding:24px;border:.5px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:16px;background:light-dark(#fff,#232324)}
h1{margin:0;font-size:20px;line-height:1.3;font-weight:500}
p{margin:0;font-size:14px;line-height:1.5;overflow-wrap:anywhere}
.description,.hint,label{color:color-mix(in srgb,currentColor 72%,transparent)}
form{display:grid;grid-template-columns:minmax(0,1fr);grid-template-areas:'label' 'input' 'feedback' 'submit';gap:12px;min-width:0}
label{grid-area:label;margin-bottom:-6px;font-size:13px;font-weight:500;line-height:1.5}
input,button{box-sizing:border-box;min-width:0;min-height:44px;padding:8px 12px;font:inherit;font-size:14px;line-height:1.5;border-radius:8px}
input{grid-area:input;width:100%;color:inherit;background:light-dark(#fafafa,#1b1b1c);border:.5px solid color-mix(in srgb,currentColor 16%,transparent)}
input[aria-invalid='true']{border:1px solid light-dark(#ec1313,#f25a5a)}
.hint,.error{grid-area:feedback;font-size:13px;line-height:1.5}
.error{color:light-dark(#ec1313,#f25a5a)}
.error:empty{display:none}
form:has(.error:not(:empty)) .hint{visibility:hidden}
button{grid-area:submit;cursor:pointer;font-weight:500;color:light-dark(#fff,#222);background:light-dark(#222,#eee);border:0}
button:disabled{cursor:wait;opacity:.6}
a{color:inherit;text-underline-offset:3px;padding:8px 0;font-size:14px;line-height:1.5}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid currentColor;outline-offset:2px}
@media(hover:hover){button:not(:disabled):hover{background:light-dark(#3c3c3d,#d4d4d4)}}
@media(pointer:coarse){input{font-size:16px}}
`

function scriptJson(value: typeof loginLocales): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function documentHtml(title: string, content: string, script: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${title}</title><style>${pageStyle}</style></head><body><main class="page"><section class="card" aria-labelledby="title">${content}</section></main><script>${script}</script></body></html>`
}

/**
 * Submit a Token through its own HTTP exchange without starting Client plugins.
 * Failed submissions remain on this page; page departure cancels an in-flight request.
 * @param locales - public copy embedded beside the entry.
 * @param tokenRejected - whether the Host already rejected a Token submission.
 */
export function enterAuthenticationPage(locales: typeof loginLocales, tokenRejected = false): void {
  const language = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const t = locales[language]
  document.documentElement.lang = language
  document.title = t.authenticationTitle
  const title = document.getElementById('title') as HTMLElement
  title.textContent = t.authenticationTitle
  const form = document.getElementById('token-form') as HTMLFormElement | null
  const description = document.getElementById('description') as HTMLElement
  description.textContent = form === null ? t.authenticationUnavailable : t.authenticationDescription
  const clean = new URL(location.href)
  clean.searchParams.delete('token')
  history.replaceState(null, '', clean)
  if (form === null) return
  const input = document.getElementById('token') as HTMLInputElement
  const error = document.getElementById('token-error') as HTMLElement
  const submit = document.getElementById('token-submit') as HTMLButtonElement
  const label = document.getElementById('token-label') as HTMLElement
  const hint = document.getElementById('token-hint') as HTMLElement
  label.textContent = t.tokenLabel
  hint.textContent = t.tokenHint
  submit.textContent = t.tokenSubmit
  if (tokenRejected) {
    error.textContent = t.tokenInvalid
    input.setAttribute('aria-invalid', 'true')
  }
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

/**
 * Render Remote's root login page, without a Token value or private boot data.
 * @param options - public Token availability, QR exchange mode, and optional rejection feedback.
 * @returns self-contained HTML for sign-in choices or the selected QR exchange at the same root entry.
 */
export function renderAuthenticationPage(options: AuthenticationPageOptions): string {
  const t = loginLocales.en
  const qrLogin = options.qrLogin === true
  const title = qrLogin ? t.title : t.authenticationTitle
  const content = qrLogin
    ? `<p id="status" role="status">${t.pending}</p><a id="open" href="./">${t.open}</a><noscript><p>${t.scriptRequired}</p></noscript>`
    : `<p id="description" class="description">${options.tokenLoginEnabled ? t.authenticationDescription : t.authenticationUnavailable}</p>${options.tokenLoginEnabled ? `<form id="token-form" action="./" method="get"><label id="token-label" for="token">${t.tokenLabel}</label><input id="token" type="password" name="token" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-describedby="token-hint token-error"${options.tokenRejected ? ' aria-invalid="true"' : ''}><p id="token-hint" class="hint">${t.tokenHint}</p><p id="token-error" class="error" role="alert">${options.tokenRejected ? t.tokenInvalid : ''}</p><button id="token-submit" type="submit">${t.tokenSubmit}</button></form>` : ''}`
  const script = qrLogin
    ? `(${enterBrowser.toString()})(${scriptJson(loginLocales)})`
    : `(${enterAuthenticationPage.toString()})(${scriptJson(loginLocales)},${options.tokenRejected === true})`
  return documentHtml(title, `<h1 id="title">${title}</h1>${content}`, script)
}

/**
 * Exchange the current page's QR fragment; all runtime dependencies must survive function serialization.
 * @param locales - Copy embedded beside the entry, before Client plugins load.
 */
export function enterBrowser(locales: typeof loginLocales): void {
  const current = new URL(location.href)
  const token = current.hash.slice(1)
  const target = new URL(current.pathname, current)
  target.searchParams.set('login', 'qr')
  history.replaceState(null, '', target)
  const language = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const t = locales[language]
  document.documentElement.lang = language
  document.title = t.title
  const title = document.getElementById('title') as HTMLElement
  const status = document.getElementById('status') as HTMLElement
  const open = document.getElementById('open') as HTMLElement
  title.textContent = t.title
  open.textContent = t.open
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    status.textContent = t.invalid
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
    if (response.status === 204) location.replace('./')
    else status.textContent = response.status === 410 ? t.invalid : t.failed
  }).catch(() => {
    // A lost response may follow a successful single-use exchange; checking the app is safe.
    if (!lifetime.signal.aborted) status.textContent = t.failed
  }).finally(() => { window.removeEventListener('pagehide', abort) })
}
