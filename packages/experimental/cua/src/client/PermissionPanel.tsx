/** Native permission status and revocable application consent on the existing plugin page. */
import { useEffect, type ReactNode } from 'react'
import { Button, IconLayersOutlineRegular, IconSettingsOutlineRegular, IconWarningOutlineRegular, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { CuaApplicationGrant, CuaSystemPermissionState } from '../access-types.ts'
import type { PermissionFace } from './controller.ts'
import type { NS } from './locales.ts'
import css from './PermissionPanel.module.css'

/** Renderer-bound permission observation and localized controls. */
export type PermissionProps = InjectFace<PermissionFace> & PropsLocale<typeof NS>

/** Permission guidance only navigates to the existing bundle details. */
export type PermissionSetupProps = PermissionProps
  & Pick<PropsRuntime<'plugins.bundle.activation'>, 'onDismiss' | 'onOpenDetails'>

function Applications({ title, apps, icons, onAction, label, disabled }: {
  title: string
  apps: readonly CuaApplicationGrant[]
  icons: Record<string, string> | null
  disabled: boolean
  label: string
  onAction: PermissionProps['revoke']
}) {
  return <section className={css.group}>
    <h4>{title}</h4>
    <ul className={css.apps}>{apps.map((app) => {
      const iconPath = app.iconPath ?? app.executablePath
      const icon = iconPath === undefined ? undefined : icons?.[iconPath]
      return <li key={app.id}>
        <div className={css.application} title={app.executablePath}>
          {icon !== undefined ? <img src={icon} alt="" width={32} height={32} draggable={false} />
            : <span className={css.iconPlaceholder} aria-hidden><IconLayersOutlineRegular size={24} /></span>}
          <strong>{app.name}</strong>
        </div>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => { onAction(app.id) }}>{label}</Button>
      </li>})}</ul>
  </section>
}

function PermissionDescription({ application, permission, loading = false, t }: Pick<PermissionProps, 't'> & {
  application: Extract<CuaSystemPermissionState, { platform: 'darwin' }>['launchApplication']
  permission: 'accessibility' | 'screenRecording'
  loading?: boolean
}) {
  if (application === undefined && !loading) return <p>{t(permission === 'accessibility' ? 'accessibilityUse' : 'screenRecordingUse')}</p>
  const [before, after] = t(permission === 'accessibility' ? 'accessibilityPermission' : 'screenRecordingPermission').split('{application}')
  return <p>
    {before}
    <span className={css.applicationBadge}>
      {application === undefined ? <span className={css.appPlaceholder} /> : <>
        {application.icon !== undefined && <img src={application.icon} alt="" width={20} height={20} draggable={false} />}
        <span>{application.name}</span>
      </>}
    </span>
    {after}
  </p>
}

function PermissionAction({ permission, granted, busy, request, openSettings, t }: Pick<PermissionProps, 'request' | 'openSettings' | 't'> & {
  permission: 'accessibility' | 'screenRecording'
  granted: boolean | null
  busy: boolean
}) {
  if (granted === false) return <Button size="sm" variant="primary" className={css.permissionAction} disabled={busy}
    onClick={() => { request(permission) }}>{t('request')}</Button>
  return <Button size="sm" variant="outline" className={css.permissionAction} disabled={busy}
    title={t('settings')} onClick={() => { openSettings(permission) }}>
    {t(granted === true ? 'granted' : 'unknown')}<IconSettingsOutlineRegular size={14} aria-hidden="true" />
  </Button>
}

function UnknownStatus({ loading, t }: Pick<PermissionProps, 't'> & { loading: boolean }) {
  return (['accessibility', 'screenRecording'] as const).map((permission) => {
    const use = t(permission === 'accessibility' ? 'accessibilityUse' : 'screenRecordingUse')
    return <div className={css.permission} key={permission} role="group" aria-label={use}>
      {loading ? <div className={css.skeletonCopy} aria-hidden="true">
        <strong>{t(permission)}</strong>
        <PermissionDescription application={undefined} permission={permission} loading t={t} />
      </div> : <div><strong>{use}</strong></div>}
      {loading ? <span className={css.buttonPlaceholder} aria-hidden /> : <span>{t('unknown')}</span>}
    </div>
  })
}

function NoticeBox({ tone, role, title, body, action }: {
  tone: 'warn' | 'danger'
  role: 'note' | 'alert'
  title: string
  body: string
  action?: ReactNode
}) {
  const danger = tone === 'danger'
  return <div className={danger ? css.dangerNotice : css.caution} role={role}>
    <div className={css.noticeMain}>
      <span className={danger ? css.dangerIcon : css.cautionIcon} aria-hidden="true"><IconWarningOutlineRegular size={14} /></span>
      <div className={css.cautionBody}>
        <p className={css.cautionTitle}>{title}</p>
        <p>{body}</p>
      </div>
    </div>
    {action}
  </div>
}

function WindowsGuidance({ system, error, busy, refresh, t }: Pick<PermissionProps, 'refresh' | 't'> & {
  system: Extract<CuaSystemPermissionState, { platform: 'windows' }> | null
  error: string | null
  busy: boolean
}) {
  return <div className={css.guidance} data-cua-guidance>
    {error !== null && <NoticeBox tone="danger" role="alert"
      title={t('windowsHelperFailed', { message: error })} body={t('queryFailedHint')}
      action={<Button size="sm" variant="outline" disabled={busy} onClick={refresh}>{t('retry')}</Button>} />}
    {/* Standing desktop conditions are notes so that opening the page does not interrupt assistive technology. */}
    {error === null && system !== null && <>
      {system.sessionLocked === true && <NoticeBox tone="danger" role="note"
        title={t('windowsLockedTitle')} body={t('windowsLockedBody')} />}
      {system.sessionLocked === null && <NoticeBox tone="danger" role="note"
        title={t('windowsSessionUnknownTitle')} body={t('windowsSessionUnknown')} />}
      {system.sessionLocked === false && !system.captureAvailable && <NoticeBox tone="warn" role="note"
        title={t('windowsCaptureUnavailableTitle')} body={t('windowsCaptureUnavailableNotice')} />}
    </>}
    <NoticeBox tone="warn" role="note" title={t('previewNoticeTitle')} body={t('previewNotice')} />
    <p>{t('windowsInstructions')}</p>
    {error === null && system !== null && !system.elevated && <p>{t('standardPrivileges')}</p>}
    <p>{t('ptcRecommendation')}</p>
  </div>
}

function systemReady(system: CuaSystemPermissionState): boolean {
  switch (system.platform) {
    case 'darwin': return system.accessibility && system.screenRecording
    case 'windows': return system.sessionLocked === false && system.captureAvailable
    /* v8 ignore next -- Native permission responses validate the closed platform union. */
    default: return assertNever(system)
  }
}

/** @param props Host observation and explicit user actions. @returns Permission controls without automatic system prompts. */
export function PermissionPanel(props: PermissionProps) {
  const { t, refresh } = props
  const state = props.useCuaPermissions(value => value)
  const observed = state.system.value
  const windows = observed?.platform === 'windows' || (observed === null && state.windowsProvider.value === true)
  const apps = state.applications.value
  const transitioning = state.changing
  const busy = transitioning || state.system.busy
  const appsBusy = transitioning || state.applications.busy
  // A failed native query leaves the platform unknown until the Host inventory says whether a Windows provider is enabled.
  const platformPending = observed === null && state.system.error !== null
    && state.windowsProvider.value === null && state.windowsProvider.error === null
  const loading = observed === null && (state.system.error === null || platformPending)
  const mac = observed?.platform === 'darwin' ? observed : null
  const win = observed?.platform === 'windows' ? observed : null
  const application = state.system.error !== null ? undefined : mac?.launchApplication
  // An unidentified platform outranks the native query failure because the page cannot tell which guidance applies.
  const providerError = observed === null ? state.windowsProvider.error : null
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh) }
  }, [refresh])
  return <div className={css.panels} data-cua-settings aria-busy={transitioning || state.busy || loading}>
    {windows ? <WindowsGuidance system={win} error={state.system.error} busy={busy} refresh={refresh} t={t} />
      : <section className={css.panel} aria-label={t('title')}>
        <div className={`${css.guidance} ${css.panelGuidance}`} data-cua-guidance>
          <NoticeBox tone="warn" role="note" title={t('previewNoticeTitle')} body={t('previewNotice')} />
          <p>{t('ptcRecommendation')}</p>
        </div>
        <h3>{t('title')}</h3>
        {state.system.error !== null && !platformPending && <NoticeBox tone="danger" role="alert"
          title={providerError === null
            ? t('queryFailed', { message: state.system.error })
            : t('providerLookupFailed', { message: providerError })}
          body={t('queryFailedHint')}
          action={<Button size="sm" variant="outline" disabled={busy} onClick={refresh}>{t('retry')}</Button>} />}
        {(observed !== null || loading) && <p
          className={observed === null ? css.pendingHint : undefined}
          aria-hidden={observed === null || undefined}
        >
          {t('permissionsIntro')}
        </p>}
        <div className={css.card}>
          {mac === null ? <UnknownStatus loading={loading} t={t} />
            : (['accessibility', 'screenRecording'] as const).map(permission => <div className={css.permission} key={permission}
              role="group" aria-label={t(permission)}>
              <div>
                <strong>{t(permission)}</strong>
                <PermissionDescription application={application} permission={permission} t={t} />
              </div>
              <PermissionAction permission={permission}
                granted={state.system.error !== null ? null : mac[permission]}
                busy={busy} request={props.request} openSettings={props.openSettings} t={t} />
            </div>)}
        </div>
      </section>}
    <section className={css.panel} aria-label={t('applicationsTitle')}>
      <h3>{t('applicationsTitle')}</h3>
      <div className={css.card}>
        {(['applications', 'icons'] as const).map(key => state[key].error !== null && <div className={css.notice} role="alert" key={key}>
          <span className={css.error}>{t(key === 'applications' ? 'applicationsFailed' : 'iconsFailed', { message: state[key].error })}</span>
          <Button size="sm" variant="outline" disabled={transitioning || state[key].busy} onClick={refresh}>{t('retry')}</Button>
        </div>)}
        {apps === null ? <p className={css.emptyState}><span className={css.appsPlaceholder} aria-hidden>{t('noApps')}</span></p> : <>
          {apps.allowedApps.length === 0 && apps.blockedApps.length === 0 && <p className={css.emptyState}>{t('noApps')}</p>}
          {apps.allowedApps.length > 0 && <Applications title={t('allowedApps')} apps={apps.allowedApps} icons={state.icons.value}
            onAction={props.revoke} label={t('revoke')} disabled={appsBusy || !apps.persistentAvailable} />}
          {apps.blockedApps.length > 0 && <Applications title={t('blockedApps')} apps={apps.blockedApps} icons={state.icons.value}
            onAction={props.retryApproval} label={t('retryApproval')} disabled={appsBusy} />}
        </>}
      </div>
    </section>
  </div>
}

/**
 * @param props Permission observation and activation navigation callbacks.
 * @returns Setup guidance when system permissions need attention.
 */
export function PermissionSetup({ t, refresh, useCuaPermissions, onDismiss, onOpenDetails }: PermissionSetupProps) {
  const state = useCuaPermissions(value => value.system)
  useEffect(() => { refresh() }, [refresh])
  const ready = state.value !== null && state.error === null
    && systemReady(state.value)
  useEffect(() => { if (ready && !state.busy) onDismiss() }, [ready, state.busy, onDismiss])
  return <Modal open={!ready && (state.value !== null || (!state.busy && state.error !== null))}
    title={t(state.value?.platform === 'windows' ? 'windowsSetupTitle' : 'setupTitle')} closeLabel={t('close')} onClose={onDismiss}
    footer={<>
      <Button variant="ghost" onClick={onDismiss}>{t('later')}</Button>
      <Button variant="primary" data-modal-autofocus onClick={onOpenDetails}>{t('openSetup')}</Button>
    </>}>
    <p>{t(state.error !== null ? 'setupQueryFailed' : state.value?.platform !== 'windows' ? 'setupBody'
      : state.value.sessionLocked === null ? 'windowsSessionUnknown'
        : state.value.sessionLocked ? 'windowsSetupBody' : 'windowsCaptureUnavailable')}</p>
  </Modal>
}

/** @param props Shared operation outcome, independent of page lifetime. @returns The existing global toast presentation. */
export function PermissionToast(props: PermissionProps) {
  const toast = props.useCuaPermissions(value => value.toast)
  if (!toast) return null
  return <Toast key={toast.id} text={toast.kind === 'failed' ? props.t('failed', { message: toast.message }) : props.t(toast.kind)}
    {...toast.kind === 'revoked' ? { tone: 'success' as const } : {}} onDone={props.dismissToast} />
}
