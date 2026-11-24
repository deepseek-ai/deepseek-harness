/**
 * The owner sign-in HTTP surface: the same-origin routes the browser still posts to.
 *
 * Share management is the `liveshareShares` Remote, so these routes only begin and report the owner's
 * Relay authorization and store the credential it returns; every share-management side effect reaches
 * the Gateway through the Remote instead.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/owner-http-routes
 */

import type { Context } from '@deepseek-ai/cordis'
import { type OwnerIdentityStatus } from '../owner-identity.ts'
import {
  OwnerAuthorizations,
  ownerAuthorizeUrl,
  type CompletedOwnerAuthorization,
  type OwnerAuthorizationRefusal,
  type OwnerAuthorizationTransaction,
  type OwnerLoginSettlement,
  type OwnerLoginView,
} from './owner-authorization.ts'
import {
  decodeOwnerCredential,
  saveOwnerCredential,
  type StoredOwnerCredential,
} from './owner-credential-file.ts'
import type { TunnelSupervision } from './tunnel-supervision.ts'
import { isRecord, json, readJsonBody } from './wire-json.ts'
import { relayFetch, type RelayFetch } from './relay-fetch.ts'

/** One owner operation's captured Relay, revision, and host instance. */
export interface OwnerOperation {
  /** Address in force when the operation was captured; absent while the owner has saved none. */
  readonly relay: string | undefined
  readonly relayRevision: number
  readonly instanceKey: string
}

/** Host state the owner sign-in routes read. */
export interface OwnerHttpRouteDeps {
  /** Host Connection service the routes are registered on. */
  readonly connection: Context['connection']
  /** Relay transport owned by this share host; absent callers use the module transport. */
  readonly relayFetch?: RelayFetch
  /** Worker registration, credential state, and Relay probes. */
  readonly tunnel: TunnelSupervision
  /** Capture the Relay, revision, and instance an operation began under. */
  readonly captureOwnerOperation: () => OwnerOperation
  /** Whether one captured operation still describes this host's Relay and instance. */
  readonly ownerOperationCurrent: (operation: OwnerOperation) => boolean
  /** Owner authorizations this host began and is waiting to redeem. */
  readonly ownerAuthorizations: OwnerAuthorizations
  /** Owner credential file, written when the Relay issues a credential. */
  readonly ownerCredentialFile: string
  /** Credential this host holds now. */
  readonly storedCredential: () => StoredOwnerCredential | undefined
  /** Replace the credential this host holds. */
  readonly setStoredCredential: (credential: StoredOwnerCredential) => void
  /**
   * Whether another running host owns the owner state directory.
   *
   * A credential is still stored here, because it is this host's own sign-in and a successor it
   * restarts as presents it; the passes that reach the Relay for the shares belong to the host that
   * owns the state, since they re-register its registrations.
   */
  readonly ownerStateHeld: () => boolean
  /** Whether this host has been disposed. */
  readonly disposed: () => boolean
}

/**
 * Origin recorded for a page whose shell forwards none.
 *
 * Such a shell serves the page from its own scheme and withholds the header after deciding the page
 * itself, so the transaction records this address in place of the one the page would have stated, and
 * every later request from that page is compared with it. The Relay requires the field in the
 * authorization URL, though a polled sign-in never posts to it.
 */
const SHELL_PAGE_ORIGIN = 'dsh-app://app'

/**
 * The origin a page's request is bound to.
 * @param request - A request the page made to this host.
 * @returns The origin the page stated, or the shell's own when its shell forwards none.
 */
function shellPageOrigin(request: Request): string {
  return request.headers.get('origin') || SHELL_PAGE_ORIGIN
}

/**
 * The status-route answer for one transaction.
 * @param view - The transaction as its page may read it, or undefined when it is unknown or lapsed.
 * @returns `pending` while no settlement exists, the stored identity, or the refusal to state.
 */
function loginStatusAnswer(view: OwnerLoginView | undefined): Response {
  if (view === undefined) return json({ status: 'failed', error: 'owner-login-expired' }, 200)
  if (view.status !== 'settled') return json({ status: 'pending' }, 200)
  const settlement = view.settlement
  return settlement.ok
    ? json({ status: 'verified', identity: settlement.identity }, 200)
    : json({ status: 'failed', error: settlement.error }, 200)
}

/**
 * The owner-facing code for one refused completion.
 *
 * The browser shows localized copy per code, so the mapping is stable and narrow: a transaction this host
 * no longer holds reads as expired (start the attempt again), and a changed Relay or host instance reads
 * as a mismatch.
 * @param refusal - The refusal the transaction store reported.
 * @returns The stable code the Owner client maps to copy.
 */
function ownerLoginFailureCode(refusal: OwnerAuthorizationRefusal): string {
  if (refusal === 'relay-changed' || refusal === 'instance-changed') return 'owner-login-mismatch'
  return 'owner-login-expired'
}

/**
 * Register the owner sign-in routes on this host's Connection.
 * @param deps - Connection, worker channel, and owner credential state.
 */
export function registerOwnerHttpRoutes(deps: OwnerHttpRouteDeps): void {
  /* v8 ignore next -- unit fixtures omit the optional owned transport; the share host always passes it. */
  const fetchRelay = deps.relayFetch ?? relayFetch
  const connection = deps.connection
  const tunnel = deps.tunnel
  const captureOwnerOperation = deps.captureOwnerOperation
  const ownerOperationCurrent = deps.ownerOperationCurrent
  const ownerAuthorizations = deps.ownerAuthorizations
  const ownerCredentialFile = deps.ownerCredentialFile
  const currentCredential = deps.storedCredential
  const setStoredCredential = deps.setStoredCredential
  const ownerStateHeld = deps.ownerStateHeld
  const disposed = deps.disposed

  /**
   * Store one Relay-issued credential and claim this host's existing shares with it.
   *
   * Shared by the two ways a credential arrives — posted by the browser, or redeemed here from an
   * authorization code — so both attribute the same shares the same way. Synchronous persistence is
   * the commit point: later probes and claims use this credential and Relay even if another operation
   * commits afterwards. A changed operation is refused before persistence, never rebound to a new Relay.
   *
   * Only the host that owns the owner state claims or re-registers: its shares are the ones the Relay
   * has registered, and a host that does not own the state holds a snapshot those claims and
   * registrations would answer for. That host still stores the credential and shares nothing until it
   * takes the state over on a later start.
   * @param operation - Captured Relay, configuration revision, and host instance.
   * @param credential - Signed credential the Relay issued for this host's instance.
   * @returns This operation's identity status, or the mismatch or storage failure to report.
   */
  const storeOwnerCredential = async (operation: OwnerOperation, credential: string): Promise<
    | { readonly ok: true; readonly status: OwnerIdentityStatus }
    | { readonly ok: false; readonly code: string }
  > => {
    // A credential posted with no address in force belongs to a configuration this host no longer has,
    // so it is refused as the mismatch it is rather than stored against an invented address.
    if (!ownerOperationCurrent(operation)) return { ok: false, code: 'owner-login-mismatch' }
    const relay = operation.relay
    if (relay === undefined) return { ok: false, code: 'owner-login-mismatch' }
    const held = currentCredential()
    const previous = held?.relay === relay ? held.expiresAt : undefined
    const decoded = decodeOwnerCredential(credential) ?? {}
    const committed: StoredOwnerCredential = { relay, credential, ...decoded }
    try {
      saveOwnerCredential(ownerCredentialFile, committed)
    } catch {
      return { ok: false, code: 'owner-credential-unavailable' }
    }
    setStoredCredential(committed)
    delete tunnel.factsFor(relay).claim
    const ownsState = !ownerStateHeld()
    // A probe asks the Relay about the credential on behalf of the whole state, and the owner actions
    // that read its answer here are refused to a host that does not own that state.
    if (ownsState) await tunnel.probeRelayCredentialSupport(relay)
    const claim = ownsState
      ? await tunnel.claimOwnedShares(relay, tunnel.credentialForRelay(relay, committed))
      : undefined
    if (ownsState) {
      // The credential in hand is now the one a registration presents, so every share this host holds
      // for that address that a refusal left offline reaches the Relay again on its own.
      tunnel.reregisterOfflineShares(relay, committed)
    }
    // A claim may have adopted the horizon the Relay reported for this very token, which replaces the
    // record with an equal one; the status therefore reports whichever record is current for this Relay.
    const heldAfterCommit = currentCredential()
    /* v8 ignore next -- a claim adoption rewrites only the horizon of the same credential. */
    const effective = heldAfterCommit?.credential === committed.credential ? heldAfterCommit : committed
    if (claim !== undefined && !disposed() && currentCredential() === effective) tunnel.factsFor(relay).claim = claim
    const renewed = previous === undefined
      || (effective.expiresAt !== undefined && effective.expiresAt > previous)
    return {
      ok: true,
      status: tunnel.ownerIdentityStatus(relay, { renewed, ...(claim === undefined ? {} : { claim }) }, effective),
    }
  }

  connection.fetch.register({
    path: '/api/liveshare.ownerCredential',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const operation = captureOwnerOperation()
      const input = await readJsonBody(request)
      if (!isRecord(input) || typeof input.credential !== 'string' || input.credential === '') {
        return json({ error: 'invalid-credential' }, 400)
      }
      const stored = await storeOwnerCredential(operation, input.credential)
      return stored.ok
        ? json(stored.status, 200)
        : json({ error: stored.code }, stored.code === 'owner-login-mismatch' ? 403 : 500)
    },
  })

  /**
   * Register one owner route whose body is a JSON object, refusing every other body with one answer.
   *
   * The login routes below read different fields out of the same envelope, so the reading and the
   * refusal are written once here rather than repeated per route.
   * @param path - Route path.
   * @param handle - Handler reading the parsed object and answering the request.
   */
  const registerOwnerJsonRoute = (
    path: string,
    handle: (input: Record<string, unknown>, request: Request) => Promise<Response> | Response,
  ): void => {
    connection.fetch.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await readJsonBody(request)
        if (!isRecord(input)) return json({ error: 'invalid-json' }, 400)
        return handle(input, request)
      },
    })
  }

  registerOwnerJsonRoute('/api/liveshare.ownerLoginStart', (_input, request) => {
    const { relay, instanceKey } = captureOwnerOperation()
    if (relay === undefined) return json({ error: 'owner-login-unavailable', reason: 'relay-required' }, 409)
    const transaction = ownerAuthorizations.begin({ relay, instanceKey, origin: shellPageOrigin(request) })
    return json({
      state: transaction.state,
      expiresAt: new Date(transaction.expiresAt).toISOString(),
      authorizeUrl: ownerAuthorizeUrl(transaction),
    }, 200)
  })

  /**
   * Exchange one collected code for a credential, and store it.
   * @param operation - Captured Relay, configuration revision, and host instance.
   * @param completed - The completed transaction's Relay, instance, and verifier.
   * @param code - Single-use code the Relay issued.
   * @returns The stored identity, or the refusal the page states.
   */
  const exchangeCode = async (
    operation: OwnerOperation,
    completed: CompletedOwnerAuthorization,
    code: string,
  ): Promise<OwnerLoginSettlement> => {
    let answer: { readonly credential?: unknown; readonly error?: unknown }
    try {
      const response = await fetchRelay(new URL(`${completed.relay}/__liveshare/owner-credential`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          code,
          code_verifier: completed.verifier,
          instanceKey: completed.instanceKey,
        }),
      })
      answer = await response.json() as { readonly credential?: unknown; readonly error?: unknown }
    } catch {
      // An unreachable Relay leaves the owner unverified; the owner may begin another attempt.
      return { ok: false, error: 'owner-login-failed' }
    }
    // The transaction and Relay code are spent; a changed configuration requires a fresh authorization.
    if (!ownerOperationCurrent(operation)) return { ok: false, error: 'owner-login-mismatch' }
    if (typeof answer.credential !== 'string' || answer.credential === '') {
      return { ok: false, error: answer.error === 'code-replayed' ? 'owner-login-replayed' : 'owner-login-failed' }
    }
    // The operation was already checked after the Relay answered, so only a storage failure remains.
    const stored = await storeOwnerCredential(operation, answer.credential)
    return stored.ok ? { ok: true, identity: stored.status } : { ok: false, error: stored.code }
  }

  /** Collections from the Relay in flight, one per transaction. */
  const collections = new Map<string, Promise<void>>()

  /**
   * Collect one transaction's code from the Relay and redeem it, at most once at a time.
   *
   * The Relay answers the same issued code to every collection until the exchange spends it, so a
   * second collection racing the first would reach a transaction the first already completed. Callers
   * share the collection in flight instead. A Relay this host cannot reach, or one that fails on its own
   * side, leaves the transaction awaiting its code for the next ask.
   * @param transaction - The transaction, still awaiting its code.
   * @returns Settles once this collection recorded what it learned.
   */
  const collectCode = (transaction: OwnerAuthorizationTransaction): Promise<void> => {
    const running = collections.get(transaction.state)
    if (running !== undefined) return running
    const state = transaction.state
    const collection = (async (): Promise<void> => {
      const operation = captureOwnerOperation()
      let polled: unknown
      try {
        const response = await fetchRelay(new URL(`${transaction.relay}/__liveshare/owner-login-poll`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state, instanceKey: transaction.instanceKey }),
          signal: AbortSignal.timeout(10_000),
        })
        if (response.status >= 500) return
        if (!response.ok) {
          ownerAuthorizations.settle(state, { ok: false, error: 'owner-login-failed' })
          return
        }
        polled = await response.json()
      } catch {
        // An unreachable Relay or an unreadable answer leaves the transaction awaiting its code.
        return
      }
      // The Relay also answers `expired` before the browser first opens the link and registers the state.
      // Only the Host's own deadline expires a live attempt.
      if (isRecord(polled) && (polled.status === 'pending' || polled.status === 'expired')) return
      if (!isRecord(polled) || polled.status !== 'issued' || typeof polled.code !== 'string' || polled.code === '') {
        ownerAuthorizations.settle(state, { ok: false, error: 'owner-login-failed' })
        return
      }
      const relay = operation.relay
      const outcome = relay === undefined
        ? { ok: false as const, code: 'relay-changed' as const }
        : ownerAuthorizations.complete({ state, relay, instanceKey: operation.instanceKey })
      // A refusal here is final: the issued code cannot complete this transaction under any later ask.
      if (!outcome.ok) {
        ownerAuthorizations.settle(state, { ok: false, error: ownerLoginFailureCode(outcome.code) })
        return
      }
      ownerAuthorizations.settle(state, await exchangeCode(operation, outcome.completed, polled.code))
    })().finally(() => { collections.delete(state) })
    collections.set(state, collection)
    return collection
  }

  /**
   * Report one transaction to the page that began it.
   *
   * The page asks with the state it minted, and only from the origin the transaction bound. A transaction
   * still awaiting its code is collected from the Relay before answering, so each ask advances it.
   * @param input - The `state` the page's attempt minted.
   * @param request - The page's request, whose origin must be the one the transaction bound.
   * @returns `pending`, the stored identity, or the refusal the page states; an unknown or lapsed
   *   transaction reads as expired.
   */
  registerOwnerJsonRoute('/api/liveshare.ownerLoginStatus', async (input, request) => {
    const state = typeof input.state === 'string' ? input.state : ''
    if (state === '') return json({ error: 'invalid-status' }, 400)
    const origin = shellPageOrigin(request)
    const view = ownerAuthorizations.read(state, origin)
    if (view?.status === 'awaiting-code') await collectCode(view.transaction)
    return loginStatusAnswer(ownerAuthorizations.read(state, origin))
  })

  registerOwnerJsonRoute('/api/liveshare.ownerLoginCancel', (input) => {
    const state = typeof input.state === 'string' ? input.state : ''
    if (state === '') return json({ error: 'invalid-cancel' }, 400)
    // Best effort by design: an attempt this host no longer holds is already unredeemable.
    return json({ cancelled: ownerAuthorizations.cancel(state) }, 200)
  })
}
