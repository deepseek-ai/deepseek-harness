/**
 * The owner sign-in HTTP surface: the four same-origin routes the browser still posts to.
 *
 * Share management is the `liveshareShares` Remote, so these routes only begin and redeem the
 * owner's Relay authorization and store the credential it returns; every share-management side
 * effect reaches the Gateway through the Remote instead.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/owner-http-routes
 */

import type { Context } from '@deepseek-ai/cordis'
import { type OwnerIdentityStatus } from '../owner-identity.ts'
import {
  OwnerAuthorizations,
  ownerAuthorizeUrl,
  type OwnerAuthorizationRefusal,
} from './owner-authorization.ts'
import {
  decodeOwnerCredential,
  saveOwnerCredential,
  type StoredOwnerCredential,
} from './owner-credential-file.ts'
import type { TunnelSupervision } from './tunnel-supervision.ts'
import { isRecord, json, readJsonBody } from './wire-json.ts'

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
  /** Whether this host has been disposed. */
  readonly disposed: () => boolean
}

/**
 * The owner-facing code for one refused completion.
 *
 * The browser shows localized copy per code, so the mapping is stable and narrow: a transaction this host
 * no longer holds reads as expired (finish the attempt again), a state or origin that does not match the
 * transaction reads as a mismatch, and a changed Relay or host instance is the same mismatch.
 * @param refusal - The refusal the transaction store reported.
 * @returns The stable code the Owner client maps to copy.
 */
function ownerLoginFailureCode(refusal: OwnerAuthorizationRefusal): string {
  if (refusal === 'origin-mismatch' || refusal === 'relay-changed' || refusal === 'instance-changed') {
    return 'owner-login-mismatch'
  }
  return 'owner-login-expired'
}

/**
 * Register the owner sign-in routes on this host's Connection.
 * @param deps - Connection, worker channel, and owner credential state.
 */
export function registerOwnerHttpRoutes(deps: OwnerHttpRouteDeps): void {
  const connection = deps.connection
  const tunnel = deps.tunnel
  const captureOwnerOperation = deps.captureOwnerOperation
  const ownerOperationCurrent = deps.ownerOperationCurrent
  const ownerAuthorizations = deps.ownerAuthorizations
  const ownerCredentialFile = deps.ownerCredentialFile
  const currentCredential = deps.storedCredential
  const setStoredCredential = deps.setStoredCredential
  const disposed = deps.disposed

  /**
   * Store one Relay-issued credential and claim this host's existing shares with it.
   *
   * Shared by the two ways a credential arrives — posted by the browser, or redeemed here from an
   * authorization code — so both attribute the same shares the same way. Synchronous persistence is
   * the commit point: later probes and claims use this credential and Relay even if another operation
   * commits afterwards. A changed operation is refused before persistence, never rebound to a new Relay.
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
    await tunnel.probeRelayCredentialSupport(relay)
    const claim = await tunnel.claimOwnedShares(relay, tunnel.credentialForRelay(relay, committed))
    // The credential in hand is now the one a registration presents, so every share this host holds
    // for that address that a refusal left offline reaches the Relay again on its own.
    tunnel.reregisterOfflineShares(relay, committed)
    // A claim may have adopted the horizon the Relay reported for this very token, which replaces the
    // record with an equal one; the status therefore reports whichever record is current for this Relay.
    const heldAfterCommit = currentCredential()
    /* v8 ignore next -- a claim adoption rewrites only the horizon of the same credential. */
    const effective = heldAfterCommit?.credential === committed.credential ? heldAfterCommit : committed
    if (!disposed() && currentCredential() === effective) tunnel.factsFor(relay).claim = claim
    const renewed = previous === undefined
      || (effective.expiresAt !== undefined && effective.expiresAt > previous)
    return { ok: true, status: tunnel.ownerIdentityStatus(relay, { renewed, claim }, effective) }
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
   * The two login routes below read different fields out of the same envelope, so the reading and the
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

  // The owner authorizes this host without the credential ever passing through the browser: the page
  // begins a transaction here, the Relay signs the owner in on its own origin and issues a single-use
  // code, and this host redeems that code with the verifier only it holds.
  connection.fetch.register({
    path: '/api/liveshare.ownerLoginStart',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const origin = request.headers.get('origin')
      if (origin === null || origin === '') {
        return json({ error: 'owner-login-unavailable', reason: 'origin-required' }, 400)
      }
      const operation = captureOwnerOperation()
      const { instanceKey } = operation
      const relay = operation.relay
      // Signing in is signing in at an address: there is nothing to authorize before the owner saves one.
      if (relay === undefined) {
        return json({ error: 'owner-login-unavailable', reason: 'relay-required' }, 409)
      }
      if (tunnel.factsFor(relay).supportsCredentials === undefined) await tunnel.probeRelayCredentialSupport(relay)
      if (!ownerOperationCurrent(operation)) return json({ error: 'owner-login-mismatch' }, 403)
      if (tunnel.factsFor(relay).supportsCredentials === false) {
        return json({ error: 'owner-login-unavailable', reason: 'relay-upgrade-required' }, 409)
      }
      const transaction = ownerAuthorizations.begin({
        relay,
        instanceKey,
        origin,
      })
      return json({
        state: transaction.state,
        expiresAt: new Date(transaction.expiresAt).toISOString(),
        // The popup posts from the Relay's own origin, which is what the page must compare against; the
        // Owner page's origin stays on this side, bound to the transaction and never published.
        messageOrigin: new URL(relay).origin,
        authorizeUrl: ownerAuthorizeUrl({
          relay,
          state: transaction.state,
          challenge: transaction.challenge,
          instanceKey: transaction.instanceKey,
          origin,
        }),
      }, 200)
    },
  })

  registerOwnerJsonRoute('/api/liveshare.ownerLoginRedeem', async (input, request) => {
    const state = typeof input.state === 'string' ? input.state : ''
    const code = typeof input.code === 'string' ? input.code : ''
    if (state === '' || code === '') {
      return json({ error: 'invalid-completion' }, 400)
    }
    const operation = captureOwnerOperation()
    const relay = operation.relay
    // No transaction can have been started without an address, so a completion arriving now is stale.
    if (relay === undefined) return json({ error: 'owner-login-mismatch' }, 403)
    const outcome = ownerAuthorizations.complete({
      state,
      origin: request.headers.get('origin') ?? undefined,
      relay,
      instanceKey: operation.instanceKey,
    })
    if (!outcome.ok) return json({ error: ownerLoginFailureCode(outcome.code) }, 403)
    let answer: { readonly credential?: unknown; readonly error?: unknown }
    try {
      const response = await fetch(new URL(`${outcome.completed.relay}/__liveshare/owner-credential`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          code,
          code_verifier: outcome.completed.verifier,
          instanceKey: outcome.completed.instanceKey,
        }),
      })
      answer = await response.json() as { readonly credential?: unknown; readonly error?: unknown }
    } catch {
      // An unreachable Relay leaves the owner unverified; the browser may begin another attempt.
      return json({ error: 'owner-login-failed' }, 502)
    }
    // The transaction and Relay code are spent; a changed configuration requires a fresh authorization.
    if (!ownerOperationCurrent(operation)) return json({ error: 'owner-login-mismatch' }, 403)
    if (typeof answer.credential !== 'string' || answer.credential === '') {
      const reason = typeof answer.error === 'string' ? answer.error : undefined
      return json({
        error: reason === 'code-replayed' ? 'owner-login-replayed' : 'owner-login-failed',
        ...(reason === undefined ? {} : { reason }),
      }, 502)
    }
    // The operation was already checked after the Relay answered, so only a storage failure remains.
    const stored = await storeOwnerCredential(operation, answer.credential)
    return stored.ok ? json(stored.status, 200) : json({ error: stored.code }, 500)
  })

  registerOwnerJsonRoute('/api/liveshare.ownerLoginCancel', (input) => {
    const state = typeof input.state === 'string' ? input.state : ''
    if (state === '') return json({ error: 'invalid-cancel' }, 400)
    // Best effort by design: an attempt this host no longer holds is already unredeemable.
    return json({ cancelled: ownerAuthorizations.cancel(state) }, 200)
  })
}
