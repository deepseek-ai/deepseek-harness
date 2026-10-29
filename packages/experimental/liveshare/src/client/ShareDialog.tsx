/** Liveshare owner-side share dialog. */

import { useEffect, useState, type ReactNode } from 'react'
import {
  Button, IconCloseOutlineRegular, IconQuestionOutlineRegular, Input, Modal,
  Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreatedShare } from '../share-api-types.ts'
import type { NS } from './locales.ts'
import type { OwnerShares } from './owner-shares.ts'
import { mayCreateShare } from './owner-identity.ts'
import type { OwnerLoginFailure, OwnerLoginPhase } from './owner-login.ts'
import { useOwnerIdentityLogin } from './owner-identity-login.ts'
import { ShareEditPanel, useShareEdit } from './ShareEditPanel.tsx'
import { ShareCreateForm, useShareCreateForm, type CreatedShareInfo } from './ShareCreateForm.tsx'
import { useShareRelayAddress } from './share-relay-address.ts'
import css from './ShareDialog.module.css'

/** Props for one session-scoped share dialog. */
export interface LiveshareShareDialogProps extends PropsLocale<typeof NS> {
  /** Session this share exposes. */
  readonly sessionId: SessionId
  /** Human-facing Session title sent with the share; the panel deliberately does not print it. */
  readonly sessionTitle: string
  /** Address the mounted share host reported as saved; empty while none is saved. */
  readonly defaultRelay: string
  /** Owner share management, addressed through the generated `liveshareShares` namespace. */
  readonly shares: OwnerShares
  /** Open the global share manager. */
  readonly onManage?: () => void
  /** Close the dialog. */
  readonly onClose: () => void
}

/**
 * Create one read-only Liveshare share and show its link.
 * @param props - Session identity, relay default, close callback, and copy.
 * @returns the share modal.
 */
export function LiveshareShareDialog({
  sessionId, sessionTitle, defaultRelay, shares, onManage, onClose, t,
}: LiveshareShareDialogProps): ReactNode {
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const {
    draft: relayDraft, busy: relayBusy, error: relayError, reverify: relayReverify,
    effectiveRelay, named: relayNamed, connectivity, connectivityError,
    permission, permissionError, testing,
    draftUnsaved: relayDraftUnsaved, editDraft, setReverify: setRelayReverify, resetPermission,
    testConnectivity, testPermission, save: saveRelayAddress,
  } = useShareRelayAddress({ shares, sessionId, defaultRelay, t })
  const {
    status: ownerIdentity, login, busy: loginBusy, needsVerification,
    refresh: refreshIdentity, begin: beginLogin, name: identityName,
    stateLine: identityStateLine, tooltip: identityTooltip, line: loginLine,
  } = useOwnerIdentityLogin({
    shares,
    relay: effectiveRelay,
    t,
    onVerified: () => {
      setRelayReverify(false)
      resetPermission()
    },
  })
  const edit = useShareEdit({
    shares,
    sessionId,
    onLink: (next) => { setLink(current => current || next) },
    t,
  })

  /**
   * Save the address the owner typed and read the host's answer back.
   * @param relayUrl - Address to put in force.
   * @returns Nothing; the hook states the outcome.
   */
  const saveRelay = (relayUrl: string): Promise<void> => saveRelayAddress(relayUrl, {
    verified: ownerIdentity.state === 'verified',
    refresh: refreshIdentity,
  })

  /**
   * Adopt the record the host answered a create with.
   *
   * The host's own record is the only statement of what it stored; until its read answers, the create
   * form's own values are what the fields show.
   * @param data - The share the host created.
   * @param info - The session permission it stored and the fork switch the request carried.
   */
  const onCreated = async (data: CreatedShare, info: CreatedShareInfo): Promise<void> => {
    setLink(data.link)
    await edit.adoptCreated(data, info.reportedMode, info.allowsFork)
  }

  const createForm = useShareCreateForm({
    shares, sessionId, sessionTitle, connectivity, permission, ownerIdentity, offered: edit.offered,
    testConnectivity, testPermission, onError: setError, onCreated, identityStateLine, t,
  })
  const { busy, modeOutcome, create, isCreating } = createForm

  const copy = async (): Promise<void> => {
    const ok = await writeClipboard(link)
    setCopied(ok)
    setError(ok ? '' : t('dialog.copyFailed'))
  }

  /**
   * Close the dialog, warning once when the owner has picks that were never saved.
   *
   * A second close after the warning discards them: the warning states that before it happens.
   */
  const requestClose = (): void => {
    if (isCreating()) return
    if (edit.dirty && !edit.discardWarned) {
      edit.warnDiscard()
      return
    }
    onClose()
  }

  /** Whether this dialog may configure and create the share: a verified owner is the only prerequisite. */
  const canConfigure = (): boolean => mayCreateShare(ownerIdentity)

  /**
   * The sign-in attempt whose phase the status line states instead of the flow's own line.
   *
   * A finished attempt leaves the line to the Host's own answer; an address that is not in force
   * outranks the attempt, because signing in cannot start there.
   * @returns The attempt to state, or undefined when the flow's own line stands.
   */
  const activeLogin = (): { readonly phase: OwnerLoginPhase; readonly failure?: OwnerLoginFailure } | undefined =>
    login === undefined || login.phase === 'verified' || !relayNamed || relayDraftUnsaved() ? undefined : login

  /**
   * The one status line the dialog states right now.
   *
   * It belongs to the first thing the owner must settle: the address, the address connection, the
   * sign-in attempt, the account state, then the publish permission. Every sentence a Host produced is
   * printed unchanged; the fallbacks state that the Host reported nothing rather than naming a cause
   * this page cannot see.
   * @returns Copy for the state the dialog is in.
   */
  const statusLine = (): string => {
    const attempt = activeLogin()
    if (attempt !== undefined) return loginLine(attempt.phase, attempt.failure)
    if (!relayNamed || relayDraftUnsaved()) {
      return relayDraftUnsaved() ? t('dialog.relayUnsavedHint') : t('dialog.addressHint')
    }
    if (relayReverify) return t('dialog.relayReverify')
    if (connectivity === 'testing') return t('dialog.connectivityChecking')
    if (connectivity === 'unreachable') return connectivityError
    if (connectivity !== 'ok') return t('dialog.connectivityChecking')
    if (!canConfigure()) return identityStateLine()
    if (permission === 'checking') return t('dialog.permissionChecking')
    if (permission === 'blocked' || permission === 'warn') return permissionError
    if (permission === 'ok') return t('dialog.permissionOk')
    return t('dialog.permissionPending')
  }

  /** Visual state of that line: a settled success, a warning, or a failure the owner must act on. */
  const statusClass = (): string | undefined => {
    const attempt = activeLogin()
    if (attempt !== undefined) return attempt.phase === 'failed' ? css.testWarn : css.description
    if (!relayNamed || relayDraftUnsaved() || relayReverify) return relayReverify ? css.testWarn : css.description
    if (connectivity === 'unreachable') return css.testFail
    if (connectivity !== 'ok') return css.description
    if (!canConfigure()) return css.testWarn
    if (permission === 'blocked') return css.testFail
    if (permission === 'warn') return css.testWarn
    if (permission === 'ok') return css.testOk
    return css.description
  }

  /** Whether a started sign-in attempt failed, which is the only status announced as an alert. */
  const statusAlerts = (): boolean => activeLogin()?.phase === 'failed'

  /**
   * Why the create action is unavailable, in the words of the state that blocks it.
   * @returns The reason for the disabled control, or undefined while it may run.
   */
  const createBlockedReason = (): string | undefined => {
    if (!relayNamed || relayDraftUnsaved()) return t('dialog.addressHint')
    if (connectivity === 'unreachable') return connectivityError
    if (!canConfigure()) return identityStateLine()
    if (permission === 'blocked') return permissionError
    return undefined
  }

  /** Whether the sign-in action may run: the address it would sign in at must be saved and answering. */
  const mayVerify = (): boolean => relayNamed && !relayDraftUnsaved() && connectivity === 'ok'

  // The permission check follows sign-in: once the Host reports a verified identity for an address
  // that answers, this host asks whether the Relay accepts its credential there without another click.
  useEffect(() => {
    if (connectivity !== 'ok' || ownerIdentity.state !== 'verified' || permission !== 'idle') return
    void testPermission()
  }, [connectivity, ownerIdentity.state, permission])

  return (
    <Modal
      open
      headless
      onClose={requestClose}
      title={t('dialog.title')}
      className={css.modal as string}
    >
      <div className={css.panel}>
        <header className={css.panelHeader}>
          <div className={css.panelTitleBlock}>
            <h2 className={css.panelTitle}>{t('dialog.title')}</h2>
            <span className={css.sessionTitle} title={sessionTitle}>{sessionTitle}</span>
          </div>
          <Tooltip label={t('dialog.help')} side="bottom">
            <button type="button" className={css.iconAction} aria-label={t('dialog.help')}>
              <IconQuestionOutlineRegular size={14} />
            </button>
          </Tooltip>
          <span className={css.headerGap} />
          {onManage === undefined ? null : (
            <button type="button" className={css.textAction} disabled={busy} onClick={onManage}>
              {t('dialog.manage')}
            </button>
          )}
          <button
            type="button"
            className={css.iconAction}
            aria-label={t(link === '' ? 'dialog.cancel' : 'dialog.done')}
            onClick={requestClose}
          >
            <IconCloseOutlineRegular size={14} />
          </button>
        </header>
        <div className={css.body}>
          {/* The address comes first: nothing downstream — connectivity, sign-in, or creating the
            share — can be settled before the owner has saved one. An untouched field states that no
            address is set; the owner types one and saves it, which is what puts it in force. */}
          <div className={css.field}>
            <span className={css.label}>{t('dialog.relay')}</span>
            <div className={css.linkRow}>
              <Input
                className={css.relayInput as string}
                value={relayDraft}
                disabled={relayBusy}
                aria-label={t('dialog.relay')}
                title={relayDraft}
                placeholder={t('dialog.relayUnset')}
                onChange={(event) => { editDraft(event.target.value) }}
                onBlur={() => {
                  if (relayDraft.trim() !== '' && (!relayNamed || relayDraftUnsaved())) void saveRelay(relayDraft)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void saveRelay(relayDraft)
                  }
                }}
              />
            </div>
            {relayDraftUnsaved() ? <span className={css.hint}>{t('dialog.relayUnsavedHint')}</span> : null}
            {relayError === '' ? null : <span className={css.testFail} role="alert">{relayError}</span>}
          </div>
          {link === '' ? null : (
            <div className={css.field}>
              <span className={css.label}>{t('dialog.shareLink')}</span>
              <div className={css.linkRow}>
                <Input
                  className={css.relayInput as string}
                  value={link}
                  readOnly
                  aria-label={t('dialog.shareLink')}
                  onFocus={(event) => { event.target.select() }}
                />
                <Button variant="outline" onClick={() => { void copy() }}>
                  {t(copied ? 'dialog.copied' : 'dialog.copy')}
                </Button>
              </div>
              <span className={css.hint}>{t('dialog.linkHelp')}</span>
            </div>
          )}
          {/* The account comes before the share's own settings: configuration is unavailable until
            the owner is signed in. The address row that used to carry both facts is gone; the status
            line below is now the one place the dialog states what is missing. */}
          <div className={css.accountRow}>
            {ownerIdentity.state === 'verified' ? (
              <>
                {ownerIdentity.avatarUrl !== undefined
                && <img className={css.identityAvatar} src={ownerIdentity.avatarUrl} alt="" />}
                <span className={css.identityName} title={identityTooltip()}>{identityName()}</span>
                <span className={css.headerGap} />
                <button
                  type="button"
                  className={css.textAction}
                  disabled={busy || loginBusy || !mayVerify()}
                  title={mayVerify() ? undefined : t('dialog.identity.verifyBlocked')}
                  onClick={beginLogin}
                >
                  {t('dialog.identity.reverify')}
                </button>
              </>
            ) : (
              <>
                {needsVerification ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || loginBusy || !mayVerify()}
                    title={mayVerify() ? undefined : t('dialog.identity.verifyBlocked')}
                    onClick={beginLogin}
                  >
                    {t('dialog.identity.verify')}
                  </Button>
                ) : ownerIdentity.state === 'unknown' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || !mayVerify()}
                    title={mayVerify() ? undefined : t('dialog.identity.verifyBlocked')}
                    onClick={() => { refreshIdentity() }}
                  >
                    {t('dialog.identity.retry')}
                  </Button>
                ) : null}
              </>
            )}
          </div>
          {/* One status line named by the first unsettled state: the sign-in phase never stacks under
            it, and every sentence the Host produced is printed unchanged. */}
          <span className={statusClass()} role={statusAlerts() ? 'alert' : 'status'}>
            {statusLine()}
          </span>
          {link === '' ? <ShareCreateForm form={createForm} disabled={!canConfigure()} t={t} /> : null}
          {/* What the share grants, edited here for an existing share. It belongs to the share, not to
            the address and account flow above it, so it renders only once a share exists; the panel
            footer carries the one save that submits all three fields. */}
          <ShareEditPanel visible={link !== ''} edit={edit} t={t} />
          {modeOutcome === 'notGranted' ? <p className={css.testWarn}>{t('dialog.sessionMode.notGranted')}</p> : null}
          {error === '' ? null : <div className={css.error} role="alert">{error}</div>}
        </div>
        <footer className={css.panelFooter}>
          {link === ''
            ? <>
              <Button variant="outline" disabled={busy} onClick={onClose}>{t('dialog.cancel')}</Button>
              <Button
                variant="primary"
                disabled={busy || testing || !relayNamed || relayDraftUnsaved() || connectivity === 'unreachable'
                  || permission === 'blocked' || !mayCreateShare(ownerIdentity)}
                title={createBlockedReason()}
                onClick={() => { void create() }}
              >
                {busy ? t('dialog.creating') : testing ? t('dialog.testing') : t('dialog.create')}
              </Button>
            </>
            : <>
              {/* The save sits outside the scrolling body, so a long list cannot push it out of view. */}
              {edit.dirty ? (
                <span className={edit.discardWarned ? css.testWarn : css.hint}>
                  {t(edit.discardWarned ? 'dialog.permissions.discard' : 'dialog.permissions.unsaved')}
                </span>
              ) : null}
              <span className={css.headerGap} />
              <Button variant="outline" onClick={requestClose}>{t('dialog.done')}</Button>
              <Button
                variant="primary"
                disabled={!edit.dirty || edit.saveBusy || edit.editableShare === undefined}
                onClick={() => { void edit.savePermissions() }}
              >
                {t(edit.saveBusy ? 'dialog.permissions.saving' : 'dialog.permissions.save')}
              </Button>
            </>}
        </footer>
      </div>
    </Modal>
  )
}
