/** Request approval and collect the browser cookie before authenticated application startup. */
import type { PairingCredential, PairingRequestId, PairingTicket } from '../pairing-types.ts'
import type { PairingLocaleKey } from './locales.ts'

/** Browser operations owned by the anonymous document. */
export interface PairingBrowser {
  /** Fetch an application-relative pairing endpoint. */
  request: typeof fetch
  /** Navigate after the requesting browser has received its login cookie. */
  navigate: (url: string) => void
}

/** Public, Host-configured bounds for anonymous recovery. */
export interface PairingRecovery {
  readonly requestTtlMs: number
  readonly pollIntervalMs: number
  /** Bounds the complete response, including reading its body. */
  readonly requestTimeoutMs: number
  /** Additional attempts after a transient failure. */
  readonly maxRetries: number
  /** Caps exponential delays starting at pollIntervalMs. */
  readonly retryMaxDelayMs: number
}

type Styles = Readonly<Record<string, string | undefined>>
type State = 'creating' | 'waiting' | 'cancelling' | 'replacing' | 'checking' | 'denied' | 'expired' | 'cancelled' | 'error'
type Operation = 'request' | 'status' | 'cancel' | 'replace' | 'check'
type Reply = { readonly status: number; readonly value: unknown }

/**
 * Mount the anonymous controls with bounded, cancellable recovery and no authenticated Client modules.
 * Serialized into the public script: runtime dependencies stay inside this function or its parameters.
 * Native Promise chains keep Preview's async-lowering helpers out of the serialized function.
 * Creation retries reuse credentials generated before sending; replacement confirms the old request ended.
 * Unknown outcomes retain credentials. Expiry requires checking browser authorization before starting again.
 * @param method - the device-pairing method rendered by the anonymous page.
 * @param styles - anonymous pairing CSS classes.
 * @param t - localized interaction copy.
 * @param requestLabel - localized initial request action.
 * @param browser - fetch and navigation for this document.
 * @param recovery - validated Host timing and retry limits.
 * @returns disposer aborting requests, timers and document listeners.
 */
export function mountPairing(
  method: HTMLElement, styles: Styles, t: Readonly<Record<PairingLocaleKey, string>>, requestLabel: string,
  browser: PairingBrowser, recovery: PairingRecovery,
): () => void {
  const doc = method.ownerDocument
  const view = doc.defaultView
  if (view === null) return () => {}
  const base = new URL('.', doc.baseURI)
  const {
    ticketOf, newCredential, button, current, show, stop, terminal, exchange, pause, read,
    fail, navigate, tick, execute, startRequest, cancelRequest, suspend, resume,
  } = {
    ticketOf(this: void, value: unknown, held: PairingCredential): PairingTicket | undefined {
      if (typeof value !== 'object' || value === null) return undefined
      const id: unknown = Reflect.get(value, 'id')
      const secret: unknown = Reflect.get(value, 'secret')
      const code: unknown = Reflect.get(value, 'code')
      const authority: unknown = Reflect.get(value, 'authority')
      const sourceIp: unknown = Reflect.get(value, 'sourceIp')
      const expiresInMs: unknown = Reflect.get(value, 'expiresInMs')
      const pollIntervalMs: unknown = Reflect.get(value, 'pollIntervalMs')
      if (id !== held.id || secret !== held.secret
        || typeof code !== 'string' || !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u.test(code)
        || typeof authority !== 'string' || authority.length === 0
        || (sourceIp !== null && typeof sourceIp !== 'string')
        || typeof expiresInMs !== 'number' || !Number.isSafeInteger(expiresInMs) || expiresInMs <= 0
        || typeof pollIntervalMs !== 'number' || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) return undefined
      return { ...held, code, authority, sourceIp, expiresInMs, pollIntervalMs }
    },
    newCredential(this: void): PairingCredential {
      // getRandomValues also works on the supported plain-HTTP login page.
      const bytes = view.crypto.getRandomValues(new Uint8Array(16))
      const uuid = new DataView(bytes.buffer)
      uuid.setUint8(6, (uuid.getUint8(6) & 15) | 64)
      uuid.setUint8(8, (uuid.getUint8(8) & 63) | 128)
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as PairingRequestId
      const secret = view.btoa(String.fromCharCode(...view.crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
      return { id, secret }
    },
    button(this: void, id: string, text: string): HTMLButtonElement {
      const element = doc.createElement('button')
      element.id = id
      element.type = 'button'
      element.className = styles.button ?? ''
      element.textContent = text
      return element
    },
    current(this: void, version: number): boolean { return active && version === generation },
    show(this: void, state: State, text: string = messages[state]): void {
      const elapsed = credential !== undefined && performance.now() >= deadline
      panel.hidden = state === 'cancelled'
      panel.dataset.state = state
      message.textContent = text
      message.setAttribute('role', state === 'error' ? 'alert' : 'status')
      code.hidden = ticket === undefined
      code.textContent = ticket === undefined ? '' : `${ticket.code.slice(0, 4)} ${ticket.code.slice(4)}`
      remaining.hidden = ticket === undefined || elapsed || state === 'error'
      cancel.hidden = credential === undefined || elapsed || state === 'error' || state === 'checking'
      cancel.disabled = busy && state !== 'creating'
      start.textContent = state === 'creating' ? t.pairCreating : state === 'cancelled' ? requestLabel : t.pairAgain
      start.disabled = busy
    },
    stop(this: void): void {
      generation++
      clearTimeout(timer)
      clearTimeout(countdown)
      controller.abort()
      controller = new AbortController()
      busy = false
    },
    terminal(this: void, state: 'denied' | 'expired' | 'cancelled'): void {
      stop()
      credential = undefined
      ticket = undefined
      show(state)
    },
    exchange(this: void, operation: 'request' | 'status' | 'cancel' | 'check', held: PairingCredential, signal: AbortSignal): Promise<Reply | undefined> {
      const attempt = new AbortController()
      return new Promise((resolve) => {
        let settled = false
        const { finish, abort } = {
          finish(this: void, reply?: Reply): void {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            signal.removeEventListener('abort', abort)
            resolve(reply)
          },
          abort(this: void): void { attempt.abort(); finish() },
        }
        const timeout = setTimeout(abort, recovery.requestTimeoutMs)
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => browser.request(operation === 'check' ? base : new URL(`pairing/${operation}`, base), {
          method: operation === 'check' ? 'HEAD' : 'POST', credentials: 'same-origin', cache: 'no-store',
          redirect: 'error', signal: attempt.signal,
          ...(operation === 'check' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(held) }),
        })).then((response) => {
          if (operation === 'check' || response.status !== 200) {
            finish({ status: response.status, value: undefined })
            attempt.abort()
            return
          }
          return response.json().then((value: unknown) => { finish({ status: response.status, value }) })
        }).catch(() => { finish() })
      })
    },
    pause(this: void, delay: number, signal: AbortSignal): Promise<void> {
      return new Promise((resolve) => {
        const { finish } = {
          finish(this: void): void { clearTimeout(wait); signal.removeEventListener('abort', finish); resolve() },
        }
        const wait = setTimeout(finish, delay)
        signal.addEventListener('abort', finish, { once: true })
      })
    },
    read(this: void, operation: 'request' | 'status' | 'cancel' | 'check', held: PairingCredential, state: State, signal: AbortSignal, failures = 0): Promise<Reply | undefined> {
      return exchange(operation, held, signal).then((reply) => {
        if (signal.aborted) return undefined
        if (reply !== undefined && reply.status !== 429 && reply.status < 500) return reply
        if (failures === recovery.maxRetries) return reply
        show(state, reply?.status === 429 ? t.pairRateLimited : t.pairRecovering)
        return pause(Math.min(recovery.retryMaxDelayMs, recovery.pollIntervalMs * 2 ** failures), signal)
          .then(() => signal.aborted ? undefined : read(operation, held, state, signal, failures + 1))
      })
    },
    fail(this: void, text: string, reply?: Reply): void { stop(); show('error', reply?.status === 429 ? t.pairRateLimitError : text) },
    navigate(this: void): void {
      stop()
      credential = undefined
      ticket = undefined
      browser.navigate(base.href)
    },
    tick(this: void, held: PairingCredential): void {
      const milliseconds = deadline - performance.now()
      if (milliseconds <= 0) {
        void execute(operation === 'replace' || operation === 'cancel' ? operation : 'check', held)
        return
      }
      const seconds = Math.ceil(milliseconds / 1000)
      remaining.textContent = t.pairRemaining.replace('{time}', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`)
      countdown = setTimeout(() => { tick(held) }, Math.min(1000, milliseconds))
    },
    execute(this: void, next: Operation, held: PairingCredential): Promise<void> {
      stop()
      operation = next
      const version = generation
      const signal = controller.signal
      const expiring = next === 'check' || performance.now() >= deadline
      busy = expiring || next !== 'status'
      const state: State = expiring ? 'checking' : next === 'request' ? 'creating' : next === 'replace' ? 'replacing' : next === 'cancel' ? 'cancelling' : 'waiting'
      show(state)
      const admission = expiring ? read('check', held, state, signal).then((reply) => {
        if (!current(version)) return
        if (reply?.status === 200) { navigate(); return }
        if (reply?.status !== 401) fail(t.pairCheckError, reply)
        // A 401 alone cannot retire a Host request that outlives the browser's deadline.
      }) : Promise.resolve()
      return admission.then(() => {
        if (!current(version)) return
        if (!expiring) tick(held)
        const creation = ticket === undefined ? read('request', held, state, signal).then((reply) => {
          if (!current(version)) return undefined
          const received = reply?.status === 200 ? ticketOf(reply.value, held) : undefined
          if (received === undefined) { fail(t.pairCreateError, reply); return undefined }
          ticket = received
          deadline = Math.min(deadline, performance.now() + received.expiresInMs)
          clearTimeout(countdown)
          if (!expiring) {
            if (performance.now() >= deadline) { void execute(next === 'request' ? 'check' : next, held); return undefined }
            tick(held)
          }
          return received
        }) : Promise.resolve(ticket)
        return creation.then((received) => {
          if (!current(version) || received === undefined) return
          if (next === 'request' && !expiring) {
            busy = false
            show('waiting')
            timer = setTimeout(() => { void execute('status', held) }, received.pollIntervalMs)
            return
          }
          return read(next === 'status' && !expiring ? 'status' : 'cancel', held, state, signal).then((reply) => {
            if (!current(version)) return
            const status: unknown = typeof reply?.value === 'object' && reply.value !== null ? Reflect.get(reply.value, 'status') : undefined
            if (reply?.status === 200 && status === 'completed') { navigate(); return }
            if (reply?.status === 200 && status === 'expired' && !expiring) {
              deadline = performance.now()
              void execute(next === 'replace' || next === 'cancel' ? next : 'check', held)
              return
            }
            if (reply?.status === 200 && (status === 'denied' || status === 'cancelled' || status === 'expired')) {
              terminal(expiring ? next === 'cancel' ? 'cancelled' : 'expired' : status)
              if (next === 'replace') startRequest()
              return
            }
            if (next === 'status' && reply?.status === 200 && status === 'pending') {
              show('waiting')
              timer = setTimeout(() => { void execute('status', held) }, received.pollIntervalMs)
            } else fail(t.pairError, reply)
          })
        })
      })
    },
    startRequest(this: void): void {
      if (!active || busy) return
      if (credential === undefined) {
        credential = newCredential()
        deadline = performance.now() + recovery.requestTtlMs
        void execute('request', credential)
      } else void execute('replace', credential)
    },
    cancelRequest(this: void): void {
      if (active && credential !== undefined && (!busy || operation === 'request')) void execute('cancel', credential)
    },
    suspend(this: void): void { active = false; stop() },
    resume(this: void): void {
      if (active) return
      active = true
      if (credential !== undefined) void execute(ticket === undefined ? 'request' : 'status', credential)
    },
  }
  const section = doc.createElement('section')
  section.className = styles.pairing ?? ''
  section.setAttribute('aria-labelledby', 'auth-pair-title')
  const title = doc.createElement('h2')
  title.id = 'auth-pair-title'
  title.className = styles.title ?? ''
  title.textContent = t.pairTitle
  const start = button('auth-pair-request', requestLabel)
  start.className = `${styles.button ?? ''} ${styles.primary ?? ''}`.trim()
  const panel = doc.createElement('div')
  panel.id = 'auth-pair-panel'
  panel.className = styles.panel ?? ''
  panel.hidden = true
  const hint = doc.createElement('p')
  hint.className = styles.hint ?? ''
  hint.textContent = t.pairHint
  const message = doc.createElement('p')
  message.className = styles.message ?? ''
  message.setAttribute('role', 'status')
  const code = doc.createElement('code')
  code.id = 'auth-pair-code'
  code.className = styles.code ?? ''
  code.setAttribute('aria-label', t.pairCode)
  code.hidden = true
  const remaining = doc.createElement('p')
  remaining.id = 'auth-pair-countdown'
  remaining.className = styles.countdown ?? ''
  remaining.setAttribute('role', 'timer')
  remaining.setAttribute('aria-live', 'off')
  remaining.hidden = true
  const feedback = doc.createElement('div')
  feedback.className = styles.feedback ?? ''
  const cancel = button('auth-pair-cancel', t.pairCancel)
  cancel.hidden = true
  feedback.append(message, remaining)
  panel.append(feedback)
  section.append(title, hint, code, start, cancel, panel)
  method.replaceChildren(section)

  let credential: PairingCredential | undefined
  let ticket: PairingTicket | undefined
  let controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let countdown: ReturnType<typeof setTimeout> | undefined
  let deadline = 0
  let busy = false
  let active = true
  let generation = 0
  let operation: Operation = 'request'
  const messages = {
    creating: t.pairCreating, waiting: t.pairWaiting, cancelling: t.pairCancelling, replacing: t.pairReplacing,
    checking: t.pairChecking, denied: t.pairDenied, expired: t.pairExpired, cancelled: '', error: t.pairError,
  }
  start.addEventListener('click', startRequest)
  cancel.addEventListener('click', cancelRequest)
  view.addEventListener('pagehide', suspend)
  view.addEventListener('pageshow', resume)
  return () => {
    suspend()
    credential = undefined
    ticket = undefined
    start.removeEventListener('click', startRequest)
    cancel.removeEventListener('click', cancelRequest)
    view.removeEventListener('pagehide', suspend)
    view.removeEventListener('pageshow', resume)
  }
}
