/**
 * Owner identity and Relay sign-in state for the share dialog.
 *
 * The owner host is the authority: it verifies the login, holds the credential, renews it while the
 * authorization lasts, and refuses a share it cannot attribute to a verified identity. This hook only
 * states what the host reported, and states nothing it did not report — an unreadable or absent answer
 * is `unknown`, never a guess from a display name.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/owner-identity-login
 */

import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { identitySubjectLabel } from '../owner-identity.ts'
import type { NS } from './locales.ts'
import { readOwnerIdentity, UNKNOWN_OWNER_IDENTITY, type OwnerIdentityStatus } from './owner-identity.ts'
import {
  beginOwnerLogin, hostOwnerLogin,
  type OwnerLoginFailure, type OwnerLoginPhase,
} from './owner-login.ts'
import type { OwnerShares } from './owner-shares.ts'

/** One sign-in attempt's state, or nothing while no attempt was started. */
export interface OwnerLoginAttempt {
  readonly phase: OwnerLoginPhase
  readonly failure?: OwnerLoginFailure
}

/** Inputs the share dialog supplies to its owner identity state. */
export interface OwnerIdentityLoginOptions {
  /** Owner share management the dialog addresses. */
  readonly shares: OwnerShares
  /** Address in force, as the host named it; the identity status is keyed on this address. */
  readonly relay: string | undefined
  /** Localized copy. */
  readonly t: PropsLocale<typeof NS>['t']
  /** Clear the states a finished sign-in replaced, before the status is re-read. */
  readonly onVerified: () => void
}

/** Owner identity and sign-in state the dialog's address row and status line present. */
export interface OwnerIdentityLogin {
  /** The status the host reported for the address in force. */
  readonly status: OwnerIdentityStatus
  /** The one attempt this dialog started, or nothing while none was started. */
  readonly login: OwnerLoginAttempt | undefined
  /** Whether a started attempt is still in flight. */
  readonly busy: boolean
  /** Whether the host reported an identity this page must verify before it may create a share. */
  readonly needsVerification: boolean
  /** Re-read the identity status for the address in force. */
  readonly refresh: () => void
  /** Start the one sign-in attempt this dialog runs, at the address in force. */
  readonly begin: () => void
  /**
   * Name the verified identity row shows: the host's name, or a label derived from the subject.
   * @returns The name, or an empty string when the host reported a subject-less identity.
   */
  readonly name: () => string
  /** What an identity row that is not verified states instead of a name, and what to do about it. */
  readonly stateLine: () => string
  /**
   * Credential detail a verified row keeps as a tooltip rather than a stacked line.
   * @returns The expiry line, with the renewal note when the host reported one.
   */
  readonly tooltip: () => string | undefined
  /**
   * Copy for the phase of the attempt in flight, and the reason a failed one states.
   * @param phase - Phase the attempt reported.
   * @param failure - Reason it ended without a verified identity, when it stated one.
   * @returns The line the status area states for that attempt.
   */
  readonly line: (phase: OwnerLoginPhase, failure: OwnerLoginFailure | undefined) => string
}

/**
 * Read the owner identity the host reports and drive its one Relay sign-in attempt.
 * @param options - Owner share management, the address in force, localized copy, and the verified hook.
 * @returns The identity status, the attempt, and the copy its row states.
 */
export function useOwnerIdentityLogin(options: OwnerIdentityLoginOptions): OwnerIdentityLogin {
  const { shares, relay, t, onVerified } = options
  const [ownerIdentity, setOwnerIdentity] = useState<OwnerIdentityStatus>(UNKNOWN_OWNER_IDENTITY)
  const [identityRead, setIdentityRead] = useState(0)
  /** What the one sign-in attempt this dialog started is doing; nothing while none was started. */
  const [login, setLogin] = useState<OwnerLoginAttempt>()
  const loginAttempt = useRef<{ cancel(): void }>()
  const mounted = useRef(true)

  // Closing this dialog ends the one attempt it started: the Relay popup closes and the host drops
  // the transaction, so no code or credential outlives the page that began it.
  useEffect(() => () => {
    mounted.current = false
    loginAttempt.current?.cancel()
  }, [])

  useEffect(() => {
    if (relay === undefined) return
    let cancelled = false
    // The status on hand describes whichever address it was read for. Naming the new address here
    // keeps a switched Relay from presenting the previous address's verified identity while the new
    // read is in flight, while a re-read of the same address keeps what it already stated.
    setOwnerIdentity(current => current.relay === relay
      ? current
      : { state: 'unknown', relay })
    const load = async (): Promise<void> => {
      try {
        const reported = await shares.identity({ relay })
        if (!cancelled) setOwnerIdentity(readOwnerIdentity(reported.ok ? reported.value : undefined, relay))
      } catch {
        if (!cancelled) setOwnerIdentity({ state: 'unknown', relay })
      }
    }
    void load()
    // The verify call to action leaves this page; whatever the Relay hands back on return, the host's
    // own answer is the fact this row states, so coming back re-reads it instead of trusting a guess.
    const refresh = (): void => { if (!document.hidden) setIdentityRead(count => count + 1) }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [relay, identityRead, shares])

  /**
   * Sign the owner in: the host mints one transaction, the Relay's popup hands back one code.
   *
   * The page submits that code only to its own host, which redeems it and stores the credential; this
   * dialog reads the host's answer back the same way it reads any other identity status.
   */
  const begin = (): void => {
    /* v8 ignore next -- both sign-in controls are disabled until the Host named an address. */
    if (relay === undefined || relay === '') return
    loginAttempt.current?.cancel()
    setLogin({ phase: 'opening' })
    loginAttempt.current = beginOwnerLogin({
      host: hostOwnerLogin(relay),
      page: window,
      report: (phase, failure) => {
        if (!mounted.current) return
        setLogin({ phase, ...(failure === undefined ? {} : { failure }) })
        // The host's own answer is the fact this row states, so a finished attempt reads it again.
        // The permission result belonged to the credential that attempt replaced, so it is re-asked.
        if (phase === 'verified') {
          onVerified()
          setIdentityRead(count => count + 1)
        }
      },
    })
  }

  const refresh = (): void => { setIdentityRead(count => count + 1) }

  /** Whether the host reported an identity this page must verify before it may create a share. */
  const needsVerification = ownerIdentity.state === 'expired'
    || ownerIdentity.state === 'unverified'
    || ownerIdentity.state === 'relay-changed'

  /**
   * Name the verified identity row shows: the host's name, or a label derived from the subject.
   * @returns The name, or an empty string when the host reported a subject-less identity.
   */
  const name = (): string => {
    if (ownerIdentity.displayName !== undefined) return ownerIdentity.displayName
    return ownerIdentity.subjectId === undefined ? '' : identitySubjectLabel(ownerIdentity.subjectId)
  }

  /** What an identity row that is not verified states instead of a name, and what to do about it. */
  const stateLine = (): string => {
    if (ownerIdentity.state === 'expired') return t('dialog.identity.expired')
    if (ownerIdentity.state === 'relay-changed') return t('dialog.identity.relayChanged')
    if (ownerIdentity.state === 'relay-unsupported') return t('dialog.identity.relayUnsupported')
    if (ownerIdentity.state === 'unverified') return t('dialog.identity.unverified')
    return t('dialog.identity.unknown')
  }

  /**
   * Credential detail a verified row keeps as a tooltip rather than a stacked line.
   * @returns The expiry line, with the renewal note when the host reported one.
   */
  const tooltip = (): string | undefined => {
    if (ownerIdentity.state !== 'verified' || ownerIdentity.expiresAt === undefined) return undefined
    const expiry = t('dialog.identity.expires', { time: new Date(ownerIdentity.expiresAt).toLocaleString() })
    return ownerIdentity.renewed === true ? `${expiry} · ${t('dialog.identity.renewed')}` : expiry
  }

  /**
   * Copy for the phase of the attempt in flight, and the reason a failed one states.
   * @param phase - Phase the attempt reported.
   * @param failure - Reason it ended without a verified identity, when it stated one.
   * @returns The line the status area states for that attempt.
   */
  const line = (phase: OwnerLoginPhase, failure: OwnerLoginFailure | undefined): string => {
    if (phase === 'opening') return t('dialog.identity.loginOpening')
    if (phase === 'waiting') return t('dialog.identity.loginWaiting')
    if (phase === 'verifying') return t('dialog.identity.loginVerifying')
    if (failure === 'cancelled') return t('dialog.identity.loginCancelled')
    if (failure === 'expired') return t('dialog.identity.loginExpired')
    if (failure === 'mismatch') return t('dialog.identity.loginMismatch')
    if (failure === 'replayed') return t('dialog.identity.loginReplayed')
    if (failure === 'unavailable') return t('dialog.identity.loginUnavailable')
    if (failure === 'blocked') return t('dialog.identity.loginBlocked')
    return t('dialog.identity.loginFailed')
  }

  return {
    status: ownerIdentity,
    login,
    busy: login !== undefined && login.phase !== 'failed' && login.phase !== 'verified',
    needsVerification,
    refresh,
    begin,
    name,
    stateLine,
    tooltip,
    line,
  }
}
