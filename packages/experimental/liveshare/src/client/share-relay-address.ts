/**
 * Relay address state for the owner share dialog.
 *
 * The owner host is the authority on the address in force: it names the saved address, stores a new
 * one, and answers the connectivity and permission checks the dialog's ordered flow runs. This hook
 * keeps those facts and the owner's draft; the step guide itself belongs to the dialog.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/share-relay-address
 */

import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NS } from './locales.ts'
import type { OwnerShares } from './owner-shares.ts'

/** Relay state read from the mounted share host; both address fields are absent until one is saved. */
interface RelayState {
  readonly override?: string
  readonly effective?: string
}

/** What the connectivity step has established for the address in force; credentials play no part. */
export type RelayConnectivity = 'idle' | 'testing' | 'ok' | 'unreachable'

/**
 * What the permission step has established for this host at that address.
 *
 * `blocked` is the Relay's refusal of this host's credential, which the owner acts on by verifying
 * again; `warn` is a failure the Relay did not decide, which keeps the gateway's retry.
 */
export type RelayPermission = 'idle' | 'checking' | 'ok' | 'blocked' | 'warn'

/**
 * The identity facts saving an address needs: whether the owner holds a verified credential at the
 * address in force, and how to re-read that status once the host stored another address.
 */
export interface RelaySaveIdentity {
  /** Whether the host reported a verified identity for the address in force. */
  readonly verified: boolean
  /** Re-read the identity status for the address the save put in force. */
  readonly refresh: () => void
}

/** Inputs the share dialog supplies to its Relay address state. */
export interface ShareRelayAddressOptions {
  /** Owner share management the dialog addresses. */
  readonly shares: OwnerShares
  /** Session whose publish permission the permission step checks. */
  readonly sessionId: SessionId
  /** Address the mounted share host reported as saved; empty while none is saved. */
  readonly defaultRelay: string
  /** Localized copy. */
  readonly t: PropsLocale<typeof NS>['t']
}

/** Relay address state the dialog's first step and its two checks present. */
export interface ShareRelayAddress {
  /** Address the owner is editing. */
  readonly draft: string
  /** Whether a save is in flight. */
  readonly busy: boolean
  /** Why the last save did not land, already localized. */
  readonly error: string
  /** What the last save put in force, already localized. */
  readonly notice: string
  /** Set when a save replaced an address that already held a verified identity. */
  readonly reverify: boolean
  /** Address the host itself named as in force, before the header action's earlier probe. */
  readonly effectiveRelay: string | undefined
  /** Whether the host's own read named the address in force. */
  readonly named: boolean
  /** Address this dialog presents as in force. */
  readonly effective: string
  /** What the connectivity step has established for that address. */
  readonly connectivity: RelayConnectivity
  /** The Host's own connectivity text, printed unchanged when it stated one. */
  readonly connectivityError: string
  /** What the permission step has established for that address. */
  readonly permission: RelayPermission
  /** The Host's own permission text, printed unchanged when it stated one. */
  readonly permissionError: string
  /** Whether either step's check is in flight. */
  readonly testing: boolean
  /** Whether the permission step is settled enough to create. */
  readonly permissionPassed: boolean
  /**
   * Whether the field holds an address of the owner's own that is not the one in force.
   *
   * A typed address equal to the one in force is not a change, whatever its source; an empty field
   * is not a change either, because it is the state before any host answer.
   * @returns True only when saving is what puts the field's address in force.
   */
  readonly draftUnsaved: () => boolean
  /** Record an edit to the address field, which the host's own answer must no longer replace. */
  readonly editDraft: (value: string) => void
  /** Clear or set the note that a saved address needs verifying again. */
  readonly setReverify: (value: boolean) => void
  /** Clear the permission result that belonged to a credential a sign-in replaced. */
  readonly resetPermission: () => void
  /**
   * Ask whether the address in force answers at all.
   *
   * This step presents no credential: a server that refuses an anonymous request has still answered,
   * so only a transport failure makes the address unreachable.
   * @returns True when the address answered.
   */
  readonly testConnectivity: () => Promise<boolean>
  /**
   * Ask whether this host may publish a share at the address in force.
   *
   * The Host decides the severity: a refusal blocks creation until the owner verifies again, while a
   * failure the Relay did not decide keeps the gateway's retry and only warns.
   * @returns True when creation may proceed.
   */
  readonly testPermission: () => Promise<boolean>
  /**
   * Save the address the owner typed and read the host's answer back.
   * @param relayUrl - Address to put in force.
   * @param identity - Whether the owner was verified at the previous address, and how to re-read it.
   */
  readonly save: (relayUrl: string, identity: RelaySaveIdentity) => Promise<void>
}

/**
 * Read, save, and check the Relay address the owner shares through.
 * @param options - Owner share management, the Session, the address prefill, and localized copy.
 * @returns The address in force, the owner's draft, and both checks.
 */
export function useShareRelayAddress(options: ShareRelayAddressOptions): ShareRelayAddress {
  const { shares, sessionId, defaultRelay, t } = options
  const [relayState, setRelayState] = useState<RelayState>()
  const [relayDraft, setRelayDraft] = useState(defaultRelay)
  /** Whether the owner has typed in the address field, so the host's own answer must not replace it. */
  const relayEdited = useRef(false)
  const [relayBusy, setRelayBusy] = useState(false)
  const [relayError, setRelayError] = useState('')
  const [relayNotice, setRelayNotice] = useState('')
  /** Set when a save replaced an address that already held a verified identity, so the owner knows. */
  const [relayReverify, setRelayReverify] = useState(false)
  const [connectivity, setConnectivity] = useState<RelayConnectivity>('idle')
  const [connectivityError, setConnectivityError] = useState('')
  const [permission, setPermission] = useState<RelayPermission>('idle')
  const [permissionError, setPermissionError] = useState('')
  /** Address the connectivity step has already been started for, so one address is asked once. */
  const checkedAddress = useRef<string>()

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const current = await shares.relay()
        if (cancelled || !current.ok) return
        setRelayState({
          ...(current.value.override === undefined ? {} : { override: current.value.override }),
          ...(current.value.effective === undefined ? {} : { effective: current.value.effective }),
        })
      } catch { /* Keep the host-provided default when the read fails. */ }
    }
    void load()
    return () => { cancelled = true }
  }, [shares])

  // The owner host verifies and holds the credential; this read only states what it reported for the
  // Relay address in force, so switching that address re-reads instead of reusing the old status.
  const effectiveRelay = relayState?.effective
  /**
   * Whether the host's own read named the address in force.
   *
   * The prop only prefills the field from the header action's earlier probe: an address this dialog
   * has not heard its own host name is not one it may sign in at or claim as in force.
   */
  const relayNamed = effectiveRelay !== undefined && effectiveRelay !== ''
  /** The address this dialog presents as in force, before the Host's own read lands. */
  const effective = effectiveRelay ?? defaultRelay
  // The host names the address in force after this dialog is already open — the read above, or the
  // header action's earlier probe — so an untouched field follows it. An empty field is the state before
  // any answer, not an address the owner typed, and it must not read as a change still to be saved.
  useEffect(() => {
    if (relayEdited.current || effective === '') return
    setRelayDraft(current => current === effective ? current : effective)
  }, [effective])

  /**
   * Ask whether the address in force answers at all.
   * @returns True when the address answered.
   */
  const testConnectivity = async (): Promise<boolean> => {
    // Nothing is in force to ask about until the host names an address, and a failure this page never
    // probed for is not a fact about the Relay: the step stays with the address until one is named.
    if (effective === '') {
      setConnectivity('idle')
      setConnectivityError('')
      return false
    }
    setConnectivity('testing')
    setConnectivityError('')
    try {
      const probe = await shares.testRelay()
      if (!probe.ok) {
        setConnectivity('unreachable')
        setConnectivityError(t('dialog.hostUnavailable'))
        return false
      }
      const detail = probe.value.error ?? ''
      if (probe.value.ok || probe.value.httpReachable) {
        setConnectivity('ok')
        return true
      }
      setConnectivity('unreachable')
      setConnectivityError(detail === '' ? t('dialog.testFail') : detail)
      return false
    } catch {
      setConnectivity('unreachable')
      setConnectivityError(t('dialog.hostUnavailable'))
      return false
    }
  }

  /**
   * Ask whether this host may publish a share at the address in force.
   * @returns True when creation may proceed.
   */
  const testPermission = async (): Promise<boolean> => {
    setPermission('checking')
    setPermissionError('')
    try {
      const probe = await shares.testPublish({ sessionId })
      if (!probe.ok) {
        // This page could not reach its own Host, which decided nothing about the Relay, so the failure
        // stays transient rather than being reported as a refusal.
        setPermission('warn')
        setPermissionError(t('dialog.hostUnavailable'))
        return true
      }
      const detail = probe.value.error ?? ''
      if (probe.value.ok) {
        setPermission('ok')
        return true
      }
      if (probe.value.blocking) {
        setPermission('blocked')
        setPermissionError(detail === '' ? t('dialog.permissionFailed') : detail)
        return false
      }
      setPermission('warn')
      setPermissionError(detail === '' ? t('dialog.testWarn') : detail)
      return true
    } catch {
      // This page could not reach its own Host, which decided nothing about the Relay, so the failure
      // stays transient rather than being reported as a refusal.
      setPermission('warn')
      setPermissionError(t('dialog.hostUnavailable'))
      return true
    }
  }

  /**
   * Save the address the owner typed and read the host's answer back.
   * @param relayUrl - Address to put in force.
   * @param identity - Whether the owner was verified at the previous address, and how to re-read it.
   */
  const save = async (relayUrl: string, identity: RelaySaveIdentity): Promise<void> => {
    /* v8 ignore next -- the address field and its Save control are disabled while a save is in flight. */
    if (relayBusy) return
    const value = relayUrl.trim()
    if (!/^https?:\/\/\S+$/u.test(value)) {
      setRelayError(t('dialog.relayInvalid'))
      return
    }
    const previous = effective
    setRelayBusy(true)
    setRelayError('')
    setRelayNotice('')
    try {
      const saved = await shares.setRelay({ relayUrl: value })
      if (!saved.ok) {
        setRelayError(saved.error.code === 'liveshareShares/invalid-relay-url'
          ? t('dialog.relayInvalid')
          : t('dialog.hostUnavailable'))
        return
      }
      // The saved value is the address in force; a Host that answers without one still leaves the
      // address the owner saved as the draft, because that is what it just accepted.
      const savedAddress = saved.value.effective ?? value
      setRelayState({
        ...(saved.value.override === undefined ? {} : { override: saved.value.override }),
        effective: savedAddress,
      })
      setRelayDraft(savedAddress)
      relayEdited.current = false
      setRelayNotice(t('dialog.relaySaved'))
      // Every result on hand describes the address that was in force; the saved one starts its own
      // connectivity and permission checks instead of inheriting another address's answer.
      checkedAddress.current = savedAddress
      setConnectivity('idle')
      setConnectivityError('')
      setPermission('idle')
      setPermissionError('')
      // A credential is bound to the address that issued it, so saving a different address means the
      // owner verifies again there; saying so before the read lands keeps the step honest.
      setRelayReverify(savedAddress !== previous && identity.verified)
      // The identity read is keyed on the address in force, and asking again here makes the new
      // address's status land with the save instead of after the next unrelated focus.
      identity.refresh()
      await testConnectivity()
    } catch {
      setRelayError(t('dialog.hostUnavailable'))
    } finally {
      setRelayBusy(false)
    }
  }

  /** Whether the field holds an address of the owner's own that is not the one in force. */
  const draftUnsaved = (): boolean => relayDraft.trim() !== '' && relayDraft.trim() !== effective

  // Connectivity is the step right after the address, so the address in force is asked once as soon as
  // the host names it. An address the owner typed but has not saved is not asked about: this host would
  // probe its own, not the draft. The host naming an address equal to the field's prefill changes no
  // value here, so the naming itself is a dependency.
  useEffect(() => {
    if (!relayNamed || draftUnsaved() || checkedAddress.current === effective) return
    checkedAddress.current = effective
    void testConnectivity()
  }, [effective, relayDraft, relayNamed])

  /** Record an edit to the address field, which the host's own answer must no longer replace. */
  const editDraft = (value: string): void => {
    relayEdited.current = true
    setRelayDraft(value)
    setRelayError('')
    setRelayNotice('')
    setRelayReverify(false)
  }

  /** Clear the permission result that belonged to a credential a sign-in replaced. */
  const resetPermission = (): void => {
    setPermission('idle')
    setPermissionError('')
  }

  return {
    draft: relayDraft,
    busy: relayBusy,
    error: relayError,
    notice: relayNotice,
    reverify: relayReverify,
    effectiveRelay,
    named: relayNamed,
    effective,
    connectivity,
    connectivityError,
    permission,
    permissionError,
    testing: connectivity === 'testing' || permission === 'checking',
    permissionPassed: permission === 'ok' || permission === 'warn',
    draftUnsaved,
    editDraft,
    setReverify: setRelayReverify,
    resetPermission,
    testConnectivity,
    testPermission,
    save,
  }
}
