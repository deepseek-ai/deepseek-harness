/**
 * The share dialog's create form: the session permission, fork switch, and lifetime, plus the one
 * create action that publishes the Session through the host.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/ShareCreateForm
 */

import { useId, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreatedShare } from '../share-api-types.ts'
import type { NS } from './locales.ts'
import type { OwnerShares } from './owner-shares.ts'
import { mayCreateShare, type OwnerIdentityStatus } from './owner-identity.ts'
import type { RelayConnectivity, RelayPermission } from './share-relay-address.ts'
import { tierSelection, type CapabilityTier } from './ShareCapabilitiesPicker.tsx'
import { SharePermissionFields } from './SharePermissionFields.tsx'
import type { ViewerCapabilityGroup } from './share-types.ts'
import { readSessionMode, type ViewerSessionMode } from './viewer-capabilities.ts'
import css from './ShareDialog.module.css'

/** What the Host reported about the values the create request carried. */
export interface CreatedShareInfo {
  /** Session permission the Host stored, read through this build's vocabulary. */
  readonly reportedMode: ViewerSessionMode | undefined
  /** Session permission the owner asked for. */
  readonly requestedMode: ViewerSessionMode
  /** Whether the create request carried the fork switch. */
  readonly allowsFork: boolean
}

/** Inputs the dialog supplies to its create form. */
export interface ShareCreateFormOptions {
  /** Owner share management the create action calls. */
  readonly shares: OwnerShares
  /** Session the share exposes. */
  readonly sessionId: SessionId
  /** Human-facing Session title sent with the share. */
  readonly sessionTitle: string
  /** What the connectivity step established for the address in force. */
  readonly connectivity: RelayConnectivity
  /** What the permission step established for this host at that address. */
  readonly permission: RelayPermission
  /** The identity status the host reported for the address in force. */
  readonly ownerIdentity: OwnerIdentityStatus
  /** Plugin endpoints the mounted plugins currently offer; none hides the endpoint control. */
  readonly offered: readonly ViewerCapabilityGroup[]
  /** Ask whether the address in force answers at all. */
  readonly testConnectivity: () => Promise<boolean>
  /** Ask whether this host may publish a share at the address in force. */
  readonly testPermission: () => Promise<boolean>
  /** State why the create action could not run, or clear the dialog's error with an empty line. */
  readonly onError: (message: string) => void
  /** Adopt the record the host created, before its own listing confirms it. */
  readonly onCreated: (created: CreatedShare, info: CreatedShareInfo) => Promise<void>
  /** The line the identity's own state states when it refuses creation. */
  readonly identityStateLine: () => string
  /** Localized copy. */
  readonly t: PropsLocale<typeof NS>['t']
}

/** Create-form state and the one create action the dialog's footer runs. */
export interface ShareCreateFormState {
  /** Whether the create request is in flight. */
  readonly busy: boolean
  /** Session permission the share this dialog creates carries. */
  readonly sessionMode: ViewerSessionMode
  /** The share's own fork switch. */
  readonly allowsFork: boolean
  /** Plugin endpoint tier the share this dialog creates carries. */
  readonly capabilityTier: CapabilityTier
  /** Plugin endpoints the mounted plugins currently offer. */
  readonly offered: readonly ViewerCapabilityGroup[]
  /** What the Host reported about the fork opt-in, stated when it cannot store it. */
  readonly modeOutcome: 'granted' | 'notGranted' | undefined
  /** Base id the create form's session permission tabs derive from. */
  readonly sessionModeControlId: string
  /** Base id the create form's plugin-endpoint tabs derive from. */
  readonly capabilityControlId: string
  /** Pick the session permission the share this dialog creates carries. */
  readonly setSessionMode: (mode: ViewerSessionMode) => void
  /** Set the share's own fork switch. */
  readonly setAllowsFork: (value: boolean) => void
  /** Pick the plugin-endpoint tier the share this dialog creates carries. */
  readonly setCapabilityTier: (tier: CapabilityTier) => void
  /** Publish the Session through the host and adopt the created record. */
  readonly create: () => Promise<void>
  /** Whether a create request is running, readable from the close handler's closure. */
  readonly isCreating: () => boolean
}

/**
 * Own the create form's values and the one create action.
 * @param options - Owner share management, the Session, the checks, and the adoption hooks.
 * @returns The form's values, ids, and create action.
 */
export function useShareCreateForm({
  shares, sessionId, sessionTitle, connectivity, permission, ownerIdentity, offered,
  testConnectivity, testPermission, onError, onCreated, identityStateLine, t,
}: ShareCreateFormOptions): ShareCreateFormState {
  const [busy, setBusy] = useState(false)
  /** Plugin endpoints the new share exposes; closed until the owner picks a tier. */
  const [capabilityTier, setCapabilityTier] = useState<CapabilityTier>('none')
  /** Tier the share this dialog creates carries; the narrowest one until the owner widens it. */
  const [sessionMode, setSessionMode] = useState<ViewerSessionMode>('view')
  /** The share's own fork switch, independent of the tier; off until the owner turns it on. */
  const [allowsFork, setAllowsFork] = useState(false)
  /** What the Host reported about that opt-in, so a Host that cannot store it is stated, never assumed. */
  const [modeOutcome, setModeOutcome] = useState<'granted' | 'notGranted' | undefined>()
  const creating = useRef(false)
  /** Base ids for the segmented controls whose selection the owner edits in this dialog. */
  const sessionModeControlId = useId()
  const capabilityControlId = useId()

  const create = async (): Promise<void> => {
    if (creating.current) return
    /* v8 ignore next 4 -- the create control is disabled in every state this check refuses. */
    if (!mayCreateShare(ownerIdentity)) {
      onError(identityStateLine())
      return
    }
    creating.current = true
    setBusy(true)
    onError('')
    try {
      // The flow is ordered and each step is confirmed here rather than trusted from an earlier
      // click: an address that does not answer cannot be verified, and a registration the Relay will
      // refuse cannot be created.
      if (connectivity !== 'ok' && !(await testConnectivity())) return
      if (permission !== 'ok' && permission !== 'warn' && !(await testPermission())) return
      const created = await shares.create({
        sessionId,
        sessionTitle,
        // The tier and the fork switch travel with the share they belong to, and the tier travels even
        // at the narrowest one: a Host that cannot store the field states so in its answer rather than
        // dropping it, and the page never assumes more than the Host reported.
        sessionMode,
        allowsFork,
      })
      if (!created.ok) throw new Error('share rejected')
      const data = created.value
      // The Host's own record is the only statement of what it stored. Its answer carries the stored
      // tier, read through this build's vocabulary, so a Host that still names the withdrawn
      // `fork-readonly` tier is read as the view tier it now is rather than as a mismatch.
      const reported = readSessionMode(data.sessionMode)
      setModeOutcome(reported === sessionMode ? 'granted' : 'notGranted')
      // Plugin endpoints are a second host write with their own validation; a failure leaves the
      // created share usable and names the endpoint save the owner can retry in Share permissions.
      if (offered.length > 0 && capabilityTier !== 'none') {
        try {
          const endpoints = await shares.setCapabilities({
            shareId: data.shareId,
            capabilities: tierSelection(offered, capabilityTier),
          })
          if (!endpoints.ok) onError(t('dialog.capabilities.createFailed'))
        } catch {
          // The share exists; only the endpoint write failed, so its link still reaches the owner.
          onError(t('dialog.capabilities.createFailed'))
        }
      }
      await onCreated(data, { reportedMode: reported, requestedMode: sessionMode, allowsFork })
    } catch {
      onError(t('dialog.hostUnavailable'))
    } finally {
      creating.current = false
      setBusy(false)
    }
  }

  return {
    busy,
    sessionMode,
    allowsFork,
    capabilityTier,
    offered,
    modeOutcome,
    sessionModeControlId,
    capabilityControlId,
    setSessionMode,
    setAllowsFork,
    setCapabilityTier,
    create,
    isCreating: () => creating.current,
  }
}

/** Props for the create form fields the dialog renders before the share exists. */
export interface ShareCreateFormProps extends PropsLocale<typeof NS> {
  /** The form's values and setters, as `useShareCreateForm` owns them. */
  readonly form: ShareCreateFormState
  /** Whether a prerequisite (an owner sign-in) still makes every field unavailable. */
  readonly disabled?: boolean
}

/**
 * Render the create form's session permission, fork switch, and lifetime fields.
 * @param props - The form state and localized copy.
 * @returns The fields shown while no share exists yet.
 */
export function ShareCreateForm({ form, disabled = false, t }: ShareCreateFormProps): ReactNode {
  const {
    busy, sessionMode, allowsFork, capabilityTier, offered,
    sessionModeControlId, capabilityControlId,
  } = form
  const unavailable = disabled || busy
  return (
    <fieldset className={css.capabilities}>
      <legend className={css.label}>{t('dialog.permissions')}</legend>
      <SharePermissionFields
        sessionMode={sessionMode}
        allowsFork={allowsFork}
        offered={offered}
        tier={capabilityTier}
        disabled={unavailable}
        sessionModeControlId={sessionModeControlId}
        capabilityControlId={capabilityControlId}
        onSessionMode={(mode) => { form.setSessionMode(mode) }}
        onAllowsFork={(value) => { form.setAllowsFork(value) }}
        onTier={(tier) => { form.setCapabilityTier(tier) }}
        t={t}
      />
      <div className={css.row}>
        <span className={css.rowLabel}>{t('dialog.expiry')}</span>
        <span className={css.description}>{t('dialog.expiry.never')}</span>
      </div>
    </fieldset>
  )
}
