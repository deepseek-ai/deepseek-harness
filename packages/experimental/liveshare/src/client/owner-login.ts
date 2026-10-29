/**
 * The owner's own Relay sign-in, driven from the page that is about to share.
 *
 * The owner host is the authority here as it is for every other identity fact: it mints one
 * short-lived transaction bound to the Relay address, the Relay instance, and this page's origin, and
 * it keeps that transaction's verifier to itself. This page opens the Relay's sign-in in a popup,
 * accepts the one-time code that popup hands back by `postMessage` — only from the origin the host
 * named, only from that popup, and only for the state the host minted — and submits the code with its
 * state to its own host. The host redeems them against the Relay and stores the credential; the page
 * reads the result back the way it reads any other identity answer.
 *
 * The page holds no credential, reads no cookie, and writes nothing to the URL, to storage, or to a
 * log: the code lives from the popup's message to the host's answer and nowhere else.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/owner-login
 */

import { readOwnerIdentity, type OwnerIdentityStatus } from './owner-identity.ts'
import { OWNER_ROUTES } from './owner-routes.ts'

/** Message type the Relay's sign-in page hands its opener. */
export const OWNER_LOGIN_CODE_TYPE = 'liveshare-auth-code'

/** Message type this page answers with, so that page closes instead of navigating on. */
export const OWNER_LOGIN_ACK_TYPE = 'liveshare-auth-ack'

/** Same-origin host endpoints one attempt uses. */
const START_ROUTE = OWNER_ROUTES.ownerLoginStart
const REDEEM_ROUTE = OWNER_ROUTES.ownerLoginRedeem
const CANCEL_ROUTE = OWNER_ROUTES.ownerLoginCancel

/** What one sign-in attempt is doing, as the dialog states it. */
export type OwnerLoginPhase = 'opening' | 'waiting' | 'verifying' | 'verified' | 'failed'

/** Why one attempt ended without a verified identity, as the host named it. */
export type OwnerLoginFailure =
  | 'blocked' | 'cancelled' | 'expired' | 'mismatch' | 'replayed' | 'unavailable' | 'failed'

/** One host-minted transaction: where to sign in, what it is bound to, and until when. */
export interface OwnerLoginTicket {
  readonly authorizeUrl: string
  readonly state: string
  /**
   * Exact origin the Relay's own sign-in page posts from, as the host binds it.
   *
   * The origin the host answered *this page* for is not this: trusting that back would accept a
   * message from whatever page happens to be at this address, and a ticket that names no sender
   * origin leaves the attempt unable to verify any message at all.
   */
  readonly messageOrigin: string
  /** UTC deadline this transaction stops being redeemable at, when the host stated one. */
  readonly expiresAt?: string
}

/** One attempt's answer: the value the host named, or the reason it could not. */
export type OwnerLoginResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: OwnerLoginFailure }

/** The same-origin host face one attempt submits to. */
export interface OwnerLoginHost {
  start(): Promise<OwnerLoginResult<OwnerLoginTicket>>
  redeem(code: string, state: string): Promise<OwnerLoginResult<OwnerIdentityStatus>>
  cancel(state: string): Promise<void>
}

/**
 * Minimal popup window one sign-in attempt reserves and drives.
 *
 * The flow reads \`closed\`, navigates \`location.href\`, calls \`close\`, and posts the acknowledgement, so
 * a page's \`open\` need not return the whole browser \`Window\`.
 */
export interface OwnerLoginPopup {
  /** Whether the sign-in page closed the window. */
  closed: boolean
  /** Address the flow navigates to the sign-in URL. */
  location: { href: string }
  /** Close the reserved window. */
  close(): void
  /** Post the acknowledgement the sign-in page waits for. */
  postMessage(message: unknown, targetOrigin: string): void
}

/**
 * The browser page one sign-in attempt drives: the popup it reserves, the messages it listens for,
 * and the timer it polls with.
 */
export interface OwnerLoginPage {
  /** Open the Relay's sign-in; null when the browser refused a popup for this gesture. */
  open(url: string, name: string, features: string): OwnerLoginPopup | null
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  setInterval(handler: () => void, ms: number): number
  clearInterval(id: number): void
}

/** Stable host error codes, and the reason this page states for each. */
const FAILURE_CODES: Readonly<Record<string, OwnerLoginFailure>> = {
  'owner-login-cancelled': 'cancelled',
  'owner-login-expired': 'expired',
  'owner-login-mismatch': 'mismatch',
  'owner-login-replayed': 'replayed',
  'owner-login-unavailable': 'unavailable',
  'owner-login-failed': 'failed',
}

/**
 * Read one host answer's failure code.
 * @param value - Decoded answer body, absent when the answer could not be read.
 * @returns The reason this page states, or undefined when the answer named none it knows.
 */
export function readOwnerLoginFailure(value: unknown): OwnerLoginFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const code = (value as Record<string, unknown>).error
  return typeof code === 'string' ? FAILURE_CODES[code] : undefined
}

/**
 * Read the one-time code a sign-in popup handed this page, or nothing when the message is not it.
 *
 * An attempt has exactly one legitimate sender, and this is where that is enforced: the origin the
 * host bound the transaction to, the popup the host's ticket opened, the message type this page
 * expects, and the state that transaction minted. A message from another window, another origin,
 * another state, or one that is not even shaped like a code is dropped without an answer and without
 * a trace, so no other page can hand this one a code it would submit.
 * @param event - Message event this page received.
 * @param expected - Origin, popup, and state the host bound this attempt to.
 * @returns The code and state to submit, or undefined when the message is not this attempt's.
 */
export function readOwnerLoginCode(
  event: { readonly origin: string; readonly source: unknown; readonly data: unknown },
  expected: { readonly origin: string; readonly source: unknown; readonly state: string },
): { readonly code: string; readonly state: string } | undefined {
  if (expected.origin === '' || expected.origin === '*') return undefined
  if (event.origin !== expected.origin) return undefined
  if (expected.source === null || expected.source === undefined) return undefined
  if (event.source !== expected.source) return undefined
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const payload = data as Record<string, unknown>
  if (payload.type !== OWNER_LOGIN_CODE_TYPE) return undefined
  if (typeof payload.state !== 'string' || payload.state === '' || payload.state !== expected.state) {
    return undefined
  }
  const code = payload.code
  if (typeof code !== 'string' || code === '') return undefined
  return { code, state: payload.state }
}

/** Read one non-empty string field from a decoded JSON object. */
function readText(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read one decoded JSON object, absent when the answer carried none. */
function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Read the sign-in URL a host named, refusing anything this page must not open.
 * @param value - Candidate URL.
 * @returns The URL, or undefined when the host named none this page may open.
 */
function readLoginUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the same-origin host face one attempt submits to.
 *
 * Every call goes to this page's own origin, so no credential, code, or address the host holds
 * crosses to another party from here.
 * @param relay - Relay address in force, so the identity answer is read for that address.
 * @param request - Fetch-like function to post with; defaults to this page's own `fetch`.
 * @returns The host face one attempt uses.
 */
export function hostOwnerLogin(
  relay: string,
  request: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): OwnerLoginHost {
  /** Post one same-origin call and read its JSON body, or undefined when it answered none. */
  const post = async (path: string, body?: unknown): Promise<{ status: number; value: unknown }> => {
    const response = await request(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const value: unknown = await response.json().catch(() => undefined)
    return { status: response.status, value }
  }
  return {
    async start() {
      let answer: { status: number; value: unknown }
      try {
        answer = await post(START_ROUTE)
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
      const body = readRecord(answer.value)
      if (body === undefined || answer.status !== 200) {
        return { ok: false, reason: readOwnerLoginFailure(answer.value) ?? 'unavailable' }
      }
      const authorizeUrl = readLoginUrl(readText(body, 'authorizeUrl'))
      const state = readText(body, 'state')
      const messageOrigin = readText(body, 'messageOrigin')
      const expiresAt = readText(body, 'expiresAt')
      // A ticket this page cannot use is refused rather than half-open: no wildcard origin, no
      // address that is not a sign-in, and no transaction without its state.
      if (
        authorizeUrl === undefined || state === undefined
        || messageOrigin === undefined || messageOrigin === '*'
      ) {
        return { ok: false, reason: 'unavailable' }
      }
      return {
        ok: true,
        value: {
          authorizeUrl,
          state,
          messageOrigin,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
      }
    },
    async redeem(code, state) {
      let answer: { status: number; value: unknown }
      try {
        answer = await post(REDEEM_ROUTE, { code, state })
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
      if (answer.status !== 200) {
        return { ok: false, reason: readOwnerLoginFailure(answer.value) ?? 'failed' }
      }
      // The binding this attempt is judged on is the Relay the host itself states, read before any
      // helper defaults an address in: a body that names no Relay, an empty or non-string one, or
      // another address is not this attempt's verified identity.
      const statedRelay = readText(readRecord(answer.value) ?? {}, 'relay')
      if (statedRelay === undefined) return { ok: false, reason: 'failed' }
      if (statedRelay !== relay) return { ok: false, reason: 'mismatch' }
      // Only a verified identity is this attempt's success: one that leaves the owner unverified is
      // not a sign-in this page may call done.
      const status = readOwnerIdentity(answer.value, relay)
      if (status.state !== 'verified') {
        return { ok: false, reason: 'failed' }
      }
      return { ok: true, value: status }
    },
    async cancel(state) {
      try {
        await post(CANCEL_ROUTE, { state })
      } catch {
        // A transaction left behind expires on its own; this page has nothing else to do about it.
      }
    },
  }
}

/**
 * Start one sign-in attempt: reserve its window, ask the host for a transaction, and take the
 * one-time code the sign-in page hands back.
 *
 * The window is reserved inside the gesture that asked for it, because a window opened after an
 * await is refused by many browsers and this flow has no safe whole-page completion to fall back on:
 * a page that navigated away would leave nobody listening for the code. A blocked window is a named
 * failure, and every way an attempt can end — the popup closing, the transaction expiring, the owner
 * cancelling, a ticket that arrives after the attempt was cancelled — drops the transaction on the
 * host instead of leaving a code redeemable behind it.
 * @param options - Host face, page, phase reporter, and the clock the deadline is read with.
 * @returns A handle that stops waiting for this attempt.
 */
export function beginOwnerLogin(options: {
  readonly host: OwnerLoginHost
  readonly page: OwnerLoginPage
  readonly report: (phase: OwnerLoginPhase, failure?: OwnerLoginFailure) => void
  readonly now?: () => number
}): { cancel(): void } {
  const { host, page, report } = options
  const now = options.now ?? (() => Date.now())
  let ticket: OwnerLoginTicket | undefined
  let stopWaiting: (() => void) | undefined
  let done = false
  /** Drop one transaction on the host, best-effort: an attempt that ended leaves nothing redeemable. */
  const drop = (state: string | undefined): void => {
    if (state !== undefined) void host.cancel(state)
  }
  const finish = (phase: OwnerLoginPhase, failure?: OwnerLoginFailure): void => {
    if (done) return
    done = true
    stopWaiting?.()
    report(phase, failure)
  }
  const popup = page.open('', 'liveshare-owner-login', 'popup=yes,width=520,height=720')
  if (popup === null) {
    // Nothing was started, so there is no transaction to drop; the owner may try again.
    report('failed', 'blocked')
    return { cancel() {} }
  }
  const close = (): void => {
    try {
      popup.close()
    } catch {
      // A window already gone needs no closing.
    }
  }
  report('opening')
  void host.start().then((started) => {
    if (!started.ok) {
      close()
      finish('failed', started.reason)
      return
    }
    if (done) {
      // The attempt was cancelled while the host was minting: the ticket that arrived late is dropped
      // here rather than left redeemable by whoever holds its state.
      drop(started.value.state)
      return
    }
    if (popup.closed) {
      drop(started.value.state)
      finish('failed', 'cancelled')
      return
    }
    const minted = started.value
    ticket = minted
    // The reserved window navigates to the sign-in the host named; this page never builds that address.
    try {
      popup.location.href = minted.authorizeUrl
    } catch {
      // A window this page cannot navigate is a window no code can arrive in: a dead end like a
      // refused popup, and the owner may try again. The transaction it was minted for is dropped and
      // the window is closed, so a ticket nobody can complete is not left redeemable behind it.
      drop(minted.state)
      close()
      finish('failed', 'blocked')
      return
    }
    report('waiting')
    const deadline = minted.expiresAt === undefined ? Number.NaN : Date.parse(minted.expiresAt)
    const onMessage = (event: MessageEvent): void => {
      const code = readOwnerLoginCode(event, {
        origin: minted.messageOrigin,
        source: popup,
        state: minted.state,
      })
      if (code === undefined) return
      stopWaiting?.()
      stopWaiting = undefined
      // The sign-in page closes on this acknowledgement instead of navigating the opener away.
      try {
        popup.postMessage({ type: OWNER_LOGIN_ACK_TYPE, state: code.state }, minted.messageOrigin)
      } catch {
        // A window that cannot be answered closes itself; the host still redeems this code.
      }
      report('verifying')
      void host.redeem(code.code, code.state).then((redeemed) => {
        // A redemption counts as this page's sign-in only when the host read a verified identity back:
        // an answer that leaves the owner unverified is not a success, whatever carried it here.
        if (redeemed.ok && redeemed.value.state === 'verified') {
          finish('verified')
          return
        }
        finish('failed', redeemed.ok ? 'failed' : redeemed.reason)
      })
    }
    page.addEventListener('message', onMessage)
    const timer = page.setInterval(() => {
      if (Number.isFinite(deadline) && now() >= deadline) {
        drop(minted.state)
        finish('failed', 'expired')
        return
      }
      if (popup.closed) {
        drop(minted.state)
        finish('failed', 'cancelled')
      }
    }, 500)
    stopWaiting = () => {
      page.removeEventListener('message', onMessage)
      page.clearInterval(timer)
    }
  })
  return {
    cancel() {
      if (done) return
      finish('failed', 'cancelled')
      close()
      drop(ticket?.state)
    },
  }
}
