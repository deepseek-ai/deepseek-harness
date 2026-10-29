/**
 * The stored share's editable permission, fork switch, and plugin-endpoint exposure, with the one
 * save that submits all three through the host.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/ShareEditPanel
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreatedShare } from '../share-api-types.ts'
import type { NS } from './locales.ts'
import type { OwnerShares } from './owner-shares.ts'
import { readStoredTier, selectionKeys, sameKeys, tierSelection, type CapabilityTier } from './ShareCapabilitiesPicker.tsx'
import { readAccess, readCapabilityGroups, type OutgoingShare, type ViewerCapabilityGroup } from './share-types.ts'
import { readSessionMode, type ViewerSessionMode } from './viewer-capabilities.ts'
import { SharePermissionFields } from './SharePermissionFields.tsx'
import css from './ShareDialog.module.css'

/** Inputs the dialog supplies to its stored-share edit state. */
export interface UseShareEditOptions {
  /** Owner share management the edit state reads and saves through. */
  readonly shares: OwnerShares
  /** Session whose share this dialog edits. */
  readonly sessionId: SessionId
  /** Adopt a link the host listed when the dialog has none yet. */
  readonly onLink: (link: string) => void
  /** Localized copy. */
  readonly t: PropsLocale<typeof NS>['t']
}

/** Stored-share values, the owner's unsaved picks, and the one save they share. */
export interface ShareEditState {
  /** Confirmed ACL scope of the share on hand, as the host reported it. */
  readonly access: ReturnType<typeof readAccess>
  /** Plugin endpoints the mounted plugins currently offer; none hides the endpoint control. */
  readonly offered: readonly ViewerCapabilityGroup[]
  /** The tier the control and the save act on: the owner's own pick, or the record's whole tier. */
  readonly tier: CapabilityTier
  /** Whether the record matches no tier, so saving replaces it instead of showing a tier it is not. */
  readonly stale: boolean
  /** The session tier the owner edits here: their pick, or the one the host reported. */
  readonly shareMode: ViewerSessionMode | undefined
  /** The fork switch the owner edits here: their pick, or the one the host reported (off when absent). */
  readonly shareFork: boolean
  /** The share whose stored record this dialog edits; nothing until the host lists one. */
  readonly editableShare: string | undefined
  /** Stored deadline; absent means the share never expires. */
  readonly expiresAt: string | undefined
  /** Whether the share holds anything the owner has picked but not saved. */
  readonly dirty: boolean
  /** Whether a close attempt already warned about unsaved changes; a second one closes. */
  readonly discardWarned: boolean
  /** Whether the save is in flight. */
  readonly saveBusy: boolean
  /** What the last accepted save stored, already localized. */
  readonly saveNotice: string
  /** Why the last save did not land, already localized. */
  readonly saveError: string
  /** Base id the tier control's own tab and panel ids derive from. */
  readonly capabilityControlId: string
  /** Base id the share's own session permission tabs derive from. */
  readonly shareModeControlId: string
  /** Record the owner's tier pick. */
  readonly pickTier: (tier: CapabilityTier) => void
  /** Record the owner's session permission pick. */
  readonly pickMode: (mode: ViewerSessionMode) => void
  /** Record the owner's fork-switch pick. */
  readonly pickFork: (fork: boolean) => void
  /** Ask the save to clear the stored deadline and make the share never expire. */
  readonly clearExpiry: () => void
  /** Save the session permission, the fork switch, and endpoint exposure through the host. */
  readonly savePermissions: () => Promise<void>
  /** Record that a close attempt warned about unsaved changes. */
  readonly warnDiscard: () => void
  /**
   * Adopt the record the host answered a create with.
   * @param created - The share the host created.
   * @param reportedMode - Session permission it stored, read through this build's vocabulary.
   * @param allowsFork - Whether the create request carried the fork switch.
   */
  readonly adoptCreated: (
    created: CreatedShare,
    reportedMode: ViewerSessionMode | undefined,
    allowsFork: boolean,
  ) => Promise<void>
}

/**
 * Read the stored share record, keep the owner's unsaved picks, and save all three editable fields.
 * @param options - Owner share management, the Session, the link adoption callback, and localized copy.
 * @returns The stored values, the owner's picks, and the one save.
 */
export function useShareEdit({
  shares, sessionId, onLink, t,
}: UseShareEditOptions): ShareEditState {
  const [confirmedAccess, setConfirmedAccess] = useState<ReturnType<typeof readAccess>>()
  /** Plugin endpoints the mounted plugins currently offer; none hides the endpoint control. */
  const [offered, setOffered] = useState<readonly ViewerCapabilityGroup[]>([])
  /** Endpoint selection the host reported for the share on hand. */
  const [storedCapabilities, setStoredCapabilities] = useState<readonly ViewerCapabilityGroup[]>([])
  const [storedExpiresAt, setStoredExpiresAt] = useState<string>()
  /** Tier and fork switch the host reported for the share on hand. */
  const [storedPermission, setStoredPermission] = useState<{
    readonly mode?: ViewerSessionMode
    readonly fork: boolean
  }>({ fork: false })
  /** The session tier and fork switch the owner picked but has not saved. */
  const [pickedTier, setPickedTier] = useState<CapabilityTier>()
  const [pickedMode, setPickedMode] = useState<ViewerSessionMode>()
  const [pickedFork, setPickedFork] = useState<boolean>()
  const [pickedExpiry, setPickedExpiry] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveNotice, setSaveNotice] = useState('')
  const [saveError, setSaveError] = useState('')
  /** Whether a close attempt already warned about unsaved changes; a second one closes. */
  const [discardWarned, setDiscardWarned] = useState(false)
  /** Base id the tier control's own tab and panel ids derive from. */
  const capabilityControlId = useId()
  /** Base id the share's own session permission tabs derive from. */
  const shareModeControlId = useId()
  /** The share whose stored record this dialog edits; nothing until the host lists one. */
  const [editableShare, setEditableShare] = useState<string>()
  /** The same share, readable from the polling closure without re-subscribing it on every adoption. */
  const permissionShare = useRef<string>()
  /** Whether the owner holds unsaved picks, readable from that same closure. */
  const unsaved = useRef(false)

  /**
   * Apply the stored values one host record carries, leaving the owner's own picks in place.
   *
   * A save the host half accepted reads its record back through here: the fields state what the host
   * stored, while a pick the save never wrote stays on screen for the retry.
   * @param share - Share the host listed.
   */
  const adoptStored = (share: OutgoingShare): void => {
    setConfirmedAccess(readAccess(share.access))
    const mode = readSessionMode(share.sessionMode)
    setStoredPermission({
      ...(mode === undefined ? {} : { mode }),
      fork: share.allowsFork === true,
    })
    setStoredCapabilities(readCapabilityGroups(share.viewerCapabilities))
    setStoredExpiresAt(share.expiresAt)
  }

  /**
   * Apply one host-reported share record to every field this dialog lets the owner edit.
   *
   * This is the one place the stored values change. A polling read adopts a record only while the
   * owner holds no unsaved pick, so those picks survive it and the panel still follows the host.
   * @param share - Share the host listed.
   */
  const adoptShare = (share: OutgoingShare): void => {
    permissionShare.current = share.shareId
    setEditableShare(share.shareId)
    onLink(share.link)
    adoptStored(share)
    setPickedTier(undefined)
    setPickedMode(undefined)
    setPickedFork(undefined)
    setPickedExpiry(false)
    setDiscardWarned(false)
  }

  /**
   * Read the host's own record for one share.
   *
   * A save is confirmed by what the host stored rather than by this page's request, so both the
   * confirming read after a save and the re-read after a half-accepted one go through here.
   * @param shareId - Share to read back.
   * @returns The listed record, or undefined when the host cannot answer with one.
   */
  const readShareRecord = async (shareId: string): Promise<OutgoingShare | undefined> => {
    try {
      const listed = await shares.list()
      if (!listed.ok) return undefined
      return listed.value.shares.find(share => share.shareId === shareId)
    } catch (_sharesUnavailable) {
      return undefined
    }
  }

  /**
   * Read the host's own record for one share back into this dialog.
   *
   * A save is confirmed by what the host stored rather than by this page's request, so this read
   * follows every successful save; when it cannot answer, the polling read adopts the share instead.
   * @param shareId - Share to read back.
   */
  const refreshShare = async (shareId: string): Promise<void> => {
    const fresh = await readShareRecord(shareId)
    if (fresh !== undefined) adoptShare(fresh)
  }

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const listed = await shares.list()
        if (cancelled || !listed.ok) return
        const existing = listed.value.shares.find(share => share.sessionId === sessionId)
        if (existing !== undefined) {
          onLink(existing.link)
          setConfirmedAccess(readAccess(existing.access))
          // The editable record belongs to one share: the first sight of that share adopts it, and
          // every later poll leaves the owner's own unsaved picks alone.
          if (permissionShare.current !== existing.shareId) {
            setSaveNotice('')
            setSaveError('')
            adoptShare(existing)
          } else if (!unsaved.current) {
            // The owner holds nothing unconfirmed, so this panel follows the host's record: a change
            // made in Share management shows here instead of two panels stating different values.
            adoptShare(existing)
          }
        }
      } catch { /* The dialog keeps the last known list when polling fails. */ }
    }
    void load()
    const timer = setInterval(() => { void load() }, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId, shares])

  // The offer list decides whether the section exists at all, so it is read once: an unreadable answer
  // means nothing is offered to this page, which presents no endpoint rather than inventing one.
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const offeredNow = await shares.capabilities()
        if (!cancelled && offeredNow.ok) setOffered(readCapabilityGroups(offeredNow.value.capabilities))
      } catch { /* A host that cannot answer offers nothing; the section stays hidden. */ }
    }
    void load()
    return () => { cancelled = true }
  }, [shares])

  /** What the share's own record is, as a whole tier or as a subset no tier represents. */
  const recordTier = readStoredTier(offered, storedCapabilities)

  /** The tier the control and the save act on: the owner's own pick, or the record's whole tier. */
  const tier: CapabilityTier = pickedTier ?? recordTier.tier

  /** The session tier the owner edits here: their pick, or the one the host reported. */
  const shareMode = pickedMode ?? storedPermission.mode

  /** The fork switch the owner edits here: their pick, or the one the host reported (off when absent). */
  const shareFork = pickedFork ?? storedPermission.fork

  /** Whether the record matches no tier, so saving replaces it instead of showing a tier it is not. */
  const capabilityStale = recordTier.stale

  /**
   * Whether the share holds anything the owner has picked but not saved.
   *
   * Each field is compared against the host's own record rather than against "was it clicked", so
   * picking a value the share already holds is not an unsaved change.
   */
  const dirty = (pickedTier !== undefined
      && !sameKeys(selectionKeys(tierSelection(offered, tier)), selectionKeys(storedCapabilities)))
    || shareMode !== storedPermission.mode
    || shareFork !== storedPermission.fork
    || (pickedExpiry && storedExpiresAt !== undefined)

  // The polling closure reads this instead of the value above, which it captured at mount.
  useEffect(() => { unsaved.current = dirty }, [dirty])

  /** Clear a previous save's outcome and warn state when the owner picks another value. */
  const pickChanged = (): void => {
    setSaveNotice('')
    setSaveError('')
    setDiscardWarned(false)
  }

  /**
   * Save the share's session tier, its fork switch, and endpoint exposure through the Host.
   *
   * They are one save for the owner: the permission write carries the tier and the switch, the
   * endpoint write carries the tier's expansion, and a refusal keeps every picked value on screen.
   * The host's own record is read back on success — and after a permission write the endpoint write
   * did not follow — so the fields state what it stored.
   */
  const savePermissions = async (): Promise<void> => {
    const shareId = editableShare
    /* v8 ignore next -- the save control is disabled while a save is in flight and until a share is adopted. */
    if (saveBusy || shareId === undefined) return
    setSaveBusy(true)
    setSaveNotice('')
    setSaveError('')
    let permissionSaved = false
    try {
      const permission = await shares.updatePermissions({
        shareId,
        ...(shareMode === undefined ? {} : { sessionMode: shareMode }),
        allowsFork: shareFork,
        ...(pickedExpiry ? { ttlMinutes: null } : {}),
      })
      if (!permission.ok) throw new Error('session permission rejected')
      // From here the permission write is on the host: a later refusal must not be stated as the whole
      // save failing.
      permissionSaved = true
      // A page no plugin offers an endpoint to cannot state an endpoint selection, so it must not
      // write one: only the permission fields it does know are saved.
      if (offered.length > 0) {
        const endpoints = await shares.setCapabilities({
          shareId,
          capabilities: tierSelection(offered, tier),
        })
        if (!endpoints.ok) throw new Error('capability selection rejected')
      }
      // The host accepted this write, so the fields state it from here; the confirming read below
      // replaces it with the record the host actually stored.
      setStoredPermission({
        ...(shareMode === undefined ? {} : { mode: shareMode }),
        fork: shareFork,
      })
      setStoredCapabilities(tierSelection(offered, tier))
      setPickedTier(undefined)
      setPickedMode(undefined)
      setPickedFork(undefined)
      setPickedExpiry(false)
      setDiscardWarned(false)
      setSaveNotice(t('dialog.permissions.saved'))
      await refreshShare(shareId)
    } catch {
      // The picks stay on screen: a refused or half-accepted save is retried by saving again, not
      // re-derived from a record the owner did not ask for.
      if (!permissionSaved) {
        setSaveError(t('dialog.permissions.failed'))
      } else {
        // The permission write landed and only the endpoint write did not: state which of the two was
        // saved, and re-read the host's record so the tier and switch read what it stored instead of
        // claiming nothing changed.
        setSaveError(t('dialog.permissions.partial'))
        const fresh = await readShareRecord(shareId)
        if (fresh !== undefined) adoptStored(fresh)
      }
    } finally {
      setSaveBusy(false)
    }
  }

  /**
   * Adopt the record the host answered a create with.
   * @param created - The share the host created.
   * @param reportedMode - Session permission it stored, read through this build's vocabulary.
   * @param allowsFork - Whether the create request carried the fork switch.
   */
  const adoptCreated = async (
    created: CreatedShare,
    reportedMode: ViewerSessionMode | undefined,
    allowsFork: boolean,
  ): Promise<void> => {
    setConfirmedAccess(readAccess(created.access))
    setStoredPermission({
      ...(reportedMode === undefined ? {} : { mode: reportedMode }),
      fork: allowsFork,
    })
    setStoredCapabilities([])
    setStoredExpiresAt(undefined)
    setPickedTier(undefined)
    setPickedMode(undefined)
    setPickedFork(undefined)
    setPickedExpiry(false)
    setSaveNotice('')
    setSaveError('')
    await refreshShare(created.shareId)
  }

  return {
    access: confirmedAccess,
    offered,
    tier,
    stale: capabilityStale,
    shareMode,
    shareFork,
    editableShare,
    expiresAt: storedExpiresAt,
    dirty,
    discardWarned,
    saveBusy,
    saveNotice,
    saveError,
    capabilityControlId,
    shareModeControlId,
    pickTier: (next) => { pickChanged(); setPickedTier(next) },
    pickMode: (next) => { pickChanged(); setPickedMode(next) },
    pickFork: (next) => { pickChanged(); setPickedFork(next) },
    clearExpiry: () => { pickChanged(); setPickedExpiry(true) },
    savePermissions,
    warnDiscard: () => { setDiscardWarned(true) },
    adoptCreated,
  }
}

/** Props for the stored share's permission section. */
export interface ShareEditPanelProps extends PropsLocale<typeof NS> {
  /** Whether a share exists to edit; the section renders nothing before one does. */
  readonly visible: boolean
  /** Stored values, owner picks, and the one save they share. */
  readonly edit: ShareEditState
}

/**
 * Render the stored share's session permission, fork switch, and endpoint tier.
 * @param props - The edit state, whether a share exists, and localized copy.
 * @returns The permission section, or nothing while no share exists.
 */
export function ShareEditPanel({ visible, edit, t }: ShareEditPanelProps): ReactNode {
  if (!visible) return null
  return (
    <fieldset className={css.capabilities}>
      <legend className={css.label}>{t('dialog.permissions')}</legend>
      <SharePermissionFields
        sessionMode={edit.shareMode}
        allowsFork={edit.shareFork}
        offered={edit.offered}
        tier={edit.tier}
        stale={edit.stale}
        disabled={edit.saveBusy}
        sessionModeControlId={edit.shareModeControlId}
        capabilityControlId={edit.capabilityControlId}
        onSessionMode={(mode) => { edit.pickMode(mode) }}
        onAllowsFork={(value) => { edit.pickFork(value) }}
        onTier={(tier) => { edit.pickTier(tier) }}
        t={t}
      />
      <div className={css.row}>
        <span className={css.rowLabel}>{t('dialog.expiry')}</span>
        <span className={css.description}>
          {edit.expiresAt === undefined
            ? t('dialog.expiry.never')
            : t('dialog.expiry.until', { time: new Date(edit.expiresAt).toISOString().slice(0, 10) })}
        </span>
        {edit.expiresAt === undefined ? null : (
          <Button variant="ghost" size="sm" disabled={edit.saveBusy} onClick={edit.clearExpiry}>
            {t('dialog.expiry.clear')}
          </Button>
        )}
      </div>
      <div className={css.field}>
        <span className={css.label}>{t('dialog.linkSharing')}</span>
        {edit.access === undefined ? (
          <p className={css.description}>{t('dialog.accessUnavailable')}</p>
        ) : (
          <>
            <p className={css.description}>
              {t(edit.access.mode === 'selected' ? 'dialog.mode.selected' : 'dialog.mode.open')}
            </p>
            {edit.access.mode !== 'selected' ? null : (
              <>
                <p className={css.description}>{t('dialog.selectedCount', { count: edit.access.selectedCount })}</p>
                <p className={css.testWarn}>{t('dialog.selectedRetired')}</p>
              </>
            )}
            {edit.access.deploymentCount > 0
              ? <p className={css.testWarn}>{t('dialog.deploymentAccess', { count: edit.access.deploymentCount })}</p>
              : null}
          </>
        )}
      </div>
      {edit.saveNotice === '' ? null : <span className={css.testOk}>{edit.saveNotice}</span>}
      {edit.saveError === '' ? null : <span className={css.testFail} role="alert">{edit.saveError}</span>}
    </fieldset>
  )
}
