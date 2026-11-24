/**
 * The owner's own Relay sign-in, driven from the page that is about to share.
 *
 * The owner host is the authority here as it is for every other identity fact: it mints one
 * short-lived transaction bound to the Relay address, the Relay instance, and this page's origin, and
 * it keeps that transaction's verifier to itself. This page opens the transaction's Relay address in a
 * browser — a window it reserved inside the click, or whatever the shell opens for the address — and
 * always offers the same address to open by hand. The owner may finish signing in in any browser: the
 * Relay holds the code it issues, the host collects and redeems it, and this page asks its host how the
 * transaction stands until it settles.
 *
 * The page holds no credential and no code, reads no cookie, and writes nothing to the URL, to storage,
 * or to a log.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/owner-login
 */

import { readOwnerIdentity, type OwnerIdentityStatus } from './owner-identity.ts'
import { OWNER_ROUTES } from './owner-routes.ts'

/** Same-origin host endpoints one attempt uses. */
const START_ROUTE = OWNER_ROUTES.ownerLoginStart
const STATUS_ROUTE = OWNER_ROUTES.ownerLoginStatus
const CANCEL_ROUTE = OWNER_ROUTES.ownerLoginCancel

/** What one sign-in attempt is doing, as the dialog states it. */
export type OwnerLoginPhase = 'opening' | 'waiting' | 'verified' | 'failed'

/** Why one attempt ended without a verified identity, as the host named it. */
export type OwnerLoginFailure =
  | 'cancelled' | 'expired' | 'mismatch' | 'replayed' | 'unavailable' | 'failed'

/** One host-minted transaction: where to sign in, and until when. */
export interface OwnerLoginTicket {
  readonly authorizeUrl: string
  readonly state: string
  /** UTC deadline this transaction stops being redeemable at, when the host stated one. */
  readonly expiresAt?: string
}

/** One attempt's answer: the value the host named, or the reason it could not. */
export type OwnerLoginResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: OwnerLoginFailure }

/** One transaction's standing: the outcome a page acts on. */
export type OwnerLoginStatusResult =
  | { readonly ok: true; readonly value: OwnerIdentityStatus }
  | { readonly ok: false; readonly pending: true }
  | { readonly ok: false; readonly reason: OwnerLoginFailure }

/** The same-origin host face one attempt submits to. */
export interface OwnerLoginHost {
  start(): Promise<OwnerLoginResult<OwnerLoginTicket>>
  /**
   * Ask this Host how one transaction stands.
   *
   * The Host collects the code from the Relay and redeems it itself, so the page learns the outcome only
   * from this answer.
   * @param state - The transaction this page minted.
   * @returns The stored identity, the news that it is pending, or the reason it ended.
   */
  status(state: string): Promise<OwnerLoginStatusResult>
  cancel(state: string): Promise<void>
}

/** Minimal window one sign-in attempt reserves and navigates. */
export interface OwnerLoginWindow {
  /** Clear the opener before navigating the reserved tab to the Relay. */
  opener: unknown
  /** Address the flow navigates to the sign-in URL. */
  location: { href: string }
  /** Close the reserved window. */
  close(): void
}

/** The browser page one sign-in attempt drives: the window it opens and the timer it polls with. */
export interface OwnerLoginPage {
  /** Open a window; null when the browser or shell gave this page none. */
  open(url: string, name: string, features?: string): OwnerLoginWindow | null
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
  const post = async (path: string, body: unknown): Promise<{ status: number; value: unknown }> => {
    const response = await request(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const value: unknown = await response.json().catch(() => undefined)
    return { status: response.status, value }
  }
  return {
    async start() {
      let answer: { status: number; value: unknown }
      try {
        answer = await post(START_ROUTE, {})
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
      const body = readRecord(answer.value)
      if (body === undefined || answer.status !== 200) {
        return { ok: false, reason: readOwnerLoginFailure(answer.value) ?? 'unavailable' }
      }
      const authorizeUrl = readLoginUrl(readText(body, 'authorizeUrl'))
      const state = readText(body, 'state')
      const expiresAt = readText(body, 'expiresAt')
      // A ticket this page cannot use is refused rather than half-open: no address that is not a
      // sign-in, and no transaction without its state.
      if (authorizeUrl === undefined || state === undefined) return { ok: false, reason: 'unavailable' }
      return { ok: true, value: { authorizeUrl, state, ...(expiresAt === undefined ? {} : { expiresAt }) } }
    },
    async status(state) {
      let answer: { status: number; value: unknown }
      try {
        answer = await post(STATUS_ROUTE, { state })
      } catch {
        // A request that did not reach the Host says nothing about the transaction; ask again.
        return { ok: false, pending: true }
      }
      if (answer.status !== 200) {
        return { ok: false, reason: readOwnerLoginFailure(answer.value) ?? 'failed' }
      }
      const body = readRecord(answer.value) ?? {}
      const status = readText(body, 'status')
      if (status === 'pending') return { ok: false, pending: true }
      if (status !== 'verified') return { ok: false, reason: readOwnerLoginFailure(body) ?? 'failed' }
      // The binding this attempt is judged on is the Relay the host states for the stored identity.
      const statedRelay = readText(readRecord(body.identity) ?? {}, 'relay')
      if (statedRelay !== relay) return { ok: false, reason: 'mismatch' }
      const identity = readOwnerIdentity(body.identity, relay)
      if (identity.state !== 'verified') return { ok: false, reason: 'failed' }
      return { ok: true, value: identity }
    },
    async cancel(state) {
      try {
        await post(CANCEL_ROUTE, { state })
      } catch (_cancelFailed) {
        // A transaction left behind expires on its own; this page has nothing else to do about it.
      }
    },
  }
}

/**
 * Start one sign-in attempt: reserve a window, ask the host for a transaction, open its Relay address,
 * and wait for the host to settle it.
 *
 * The window is reserved inside the gesture that asked for it, because a window opened after an await is
 * refused by many browsers. A page that got no window — the Desktop shell denies one and opens the address
 * in the system browser instead — opens the address directly once it is known. Neither proves a browser
 * is on screen, so the address is always reported for the owner to open by hand. Each tick asks the host
 * how the transaction stands, skipping while the previous ask is unanswered. Every way an attempt can end
 * other than success — the deadline, the owner cancelling, a ticket that arrives after the attempt was
 * cancelled, a refusal — drops the transaction on the host.
 * @param options - Host face, page, phase reporter, and the clock the deadline is read with.
 * @returns A handle that stops waiting for this attempt.
 */
export function beginOwnerLogin(options: {
  readonly host: OwnerLoginHost
  readonly page: OwnerLoginPage
  /** `link` is the Relay address to open by hand, reported with the `waiting` phase. */
  readonly report: (phase: OwnerLoginPhase, failure?: OwnerLoginFailure, link?: string) => void
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
  const reserved = page.open('', '_blank')
  const close = (): void => {
    try {
      reserved?.close()
    } catch (_windowGone) {
      // A window already gone needs no closing.
    }
  }
  /**
   * Ask the host how the transaction stands until it settles or its deadline passes.
   * @param minted - The transaction this attempt opened.
   */
  const waitForSettlement = (minted: OwnerLoginTicket): void => {
    const deadline = minted.expiresAt === undefined ? Number.NaN : Date.parse(minted.expiresAt)
    let stopped = false
    let asking = false
    const timer = page.setInterval(() => {
      if (stopped || asking) return
      if (Number.isFinite(deadline) && now() >= deadline) {
        drop(minted.state)
        finish('failed', 'expired')
        return
      }
      asking = true
      void host.status(minted.state).then((standing) => {
        asking = false
        if (stopped) return
        if (standing.ok) {
          finish('verified')
          return
        }
        if ('pending' in standing) return
        // An ending the host settled leaves nothing to drop; one it refused to read may still be pending.
        drop(minted.state)
        finish('failed', standing.reason)
      })
    }, 1_000)
    stopWaiting = () => {
      stopped = true
      page.clearInterval(timer)
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
    const minted = started.value
    ticket = minted
    if (reserved === null) {
      page.open(minted.authorizeUrl, '_blank', 'noopener')
    } else {
      try {
        reserved.opener = null
        reserved.location.href = minted.authorizeUrl
      } catch {
        // Do not leave an unusable tab open beside the manual sign-in link.
        close()
      }
    }
    report('waiting', undefined, minted.authorizeUrl)
    waitForSettlement(minted)
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
