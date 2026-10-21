/** Native permission status and revocable application consent on the existing plugin page. */
import { useEffect, useState } from 'react'
import { Button, IconSettingsOutlineRegular, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CuaApplicationGrant, CuaSystemPermissionState } from '../access-types.ts'
import type { PermissionFace } from './controller.ts'
import type { NS } from './locales.ts'
import css from './PermissionPanel.module.css'

/** Renderer-bound permission observation and localized controls. */
export type PermissionProps = InjectFace<PermissionFace> & PropsLocale<typeof NS>

/** Permission guidance only navigates to the existing bundle details. */
export type PermissionSetupProps = PermissionProps
  & Pick<PropsRuntime<'plugins.bundle.activation'>, 'onDismiss' | 'onOpenDetails'>

type DefaultPresetProps = PermissionProps & InjectFace<{
  hooks: { cuaDefaultPreset: ConfigForm<{ default: string; selectedDefault?: string }> }
  setPtcDefault: () => Promise<boolean>
}>

type PersistentPtcProps = PermissionProps & { setPersistentPtc: () => Promise<boolean> }

/** The detail page owns explicit preset and execution-mode settings. */
export type PermissionPanelProps = PermissionProps & DefaultPresetProps & PersistentPtcProps

function DefaultPresetSetting(props: DefaultPresetProps) {
  const preset = props.useCuaDefaultPreset(value => value)
  const changing = props.useCuaPermissions(value => value.changing)
  return <ConfigurationSetting kind="default" status={preset.value !== undefined && preset.status === 'loading' ? 'ready' : preset.status} loading={preset.value === undefined && preset.status === 'loading'} writable={preset.writable} t={props.t} busy={changing} save={props.setPtcDefault}
    configured={(preset.value?.selectedDefault ?? preset.value?.default) === 'ptc'} />
}

function PersistentPtcSetting(props: PersistentPtcProps) {
  const runtime = props.useCuaPermissions(value => value.runtime)
  const changing = props.useCuaPermissions(value => value.changing)
  return <ConfigurationSetting kind="persistent" loading={runtime.value === null && runtime.error === null}
    status={runtime.error !== null ? 'unavailable' : runtime.value !== null ? 'ready' : 'loading'} writable={runtime.value?.writable === true} t={props.t} busy={changing || runtime.busy} save={props.setPersistentPtc}
    configured={runtime.value?.persistent === true} />
}

function ConfigurationSetting({ kind, status, loading, writable, configured, save, t, busy }: PropsLocale<typeof NS> & {
  kind: 'default' | 'persistent'
  busy: boolean
  status: 'loading' | 'ready' | 'unavailable'
  loading: boolean
  writable: boolean
  configured: boolean
  save: () => Promise<boolean>
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      if (!await save()) setError(t(`${kind}NotSaved`))
    } catch (error) {
      setError(t(`${kind}Failed`, { message: error instanceof Error ? error.message : String(error) }))
    } finally { setSaving(false) }
  }
  return <div className={css.defaultSetting} role="group" aria-label={t(`${kind}Title`)}>
    <div className={css.permission}>
      <div><strong>{t(`${kind}Title`)}</strong><p>{t(`${kind}Body`)}</p></div>
      {loading ? <span className={css.buttonPlaceholder} aria-hidden />
        : <Button size="sm" className={css.permissionAction} data-configured={configured || undefined} variant={configured ? 'outline' : 'primary'} disabled={busy || saving || configured || !writable || status !== 'ready'}
          onClick={() => { void submit() }}>{t(configured ? `${kind}Set` : `${kind}Confirm`)}</Button>}
    </div>
    {!configured && (status === 'unavailable' ? <p className={css.error} role="alert">{t(`${kind}Unavailable`)}</p>
      : status === 'ready' && !writable && <p className={css.error} role="alert">{t(`${kind}ReadOnly`)}</p>)}
    {error !== null && <p className={css.error} role="alert">{error}</p>}
  </div>
}

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
    <ul className={css.apps}>{apps.map(app => <li key={app.id}>
      <div className={css.application} title={app.executablePath}>
        {icons?.[app.executablePath] !== undefined ? <img src={icons[app.executablePath]} alt="" width={32} height={32} draggable={false} />
          : <span className={css.iconPlaceholder} aria-hidden />}
        <strong>{app.name}</strong>
      </div>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => { onAction(app.id) }}>{label}</Button>
    </li>)}</ul>
  </section>
}

function PermissionDescription({ application, permission, loading, t }: Pick<PermissionProps, 't'> & {
  application: CuaSystemPermissionState['launchApplication']
  permission: 'accessibility' | 'screenRecording'
  loading: boolean
}) {
  if (!loading && application === undefined) return <p>{t(permission === 'accessibility' ? 'accessibilityUse' : 'screenRecordingUse')}</p>
  const [before, after] = t(permission === 'accessibility' ? 'accessibilityPermission' : 'screenRecordingPermission').split('{application}')
  return <p>
    {before}
    <span className={css.applicationBadge}>
      {application === undefined ? <span className={css.appPlaceholder} aria-hidden /> : <>
        {application.icon !== undefined && <img src={application.icon} alt="" width={20} height={20} draggable={false} />}
        <span>{application.name}</span>
      </>}
    </span>
    {after}
  </p>
}

function PermissionAction({ permission, granted, loading, busy, request, openSettings, t }: Pick<PermissionProps, 'request' | 'openSettings' | 't'> & {
  permission: 'accessibility' | 'screenRecording'
  granted: boolean | null
  loading: boolean
  busy: boolean
}) {
  if (loading) return <span className={css.buttonPlaceholder} aria-hidden />
  if (granted === false) return <Button size="sm" variant="primary" className={css.permissionAction} disabled={busy}
    onClick={() => { request(permission) }}>{t('request')}</Button>
  return <Button size="sm" variant="outline" className={css.permissionAction} disabled={busy}
    title={t('settings')} onClick={() => { openSettings(permission) }}>
    {t(granted === true ? 'granted' : 'unknown')}<IconSettingsOutlineRegular size={14} aria-hidden="true" />
  </Button>
}

/** @param props Host observation and explicit user actions. @returns Permission controls without automatic system prompts. */
export function PermissionPanel(props: PermissionPanelProps) {
  const { t, refresh } = props
  const state = props.useCuaPermissions(value => value)
  const observed = state.system.value
  const apps = state.applications.value
  const transitioning = state.changing
  const busy = transitioning || state.system.busy
  const appsBusy = transitioning || state.applications.busy
  const loading = observed === null && state.system.error === null
  const application = state.system.error !== null ? undefined : observed?.launchApplication
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh) }
  }, [refresh])
  return <div className={css.panels} data-cua-settings aria-busy={transitioning || state.busy || loading}>
    <section className={css.panel} aria-label={t('title')}>
      <h3>{t('title')}</h3>
      <div className={css.card}>
        <DefaultPresetSetting {...props} />
        <PersistentPtcSetting {...props} />
        {state.system.error !== null && <div className={css.notice} role="alert">
          <span className={css.error}>{t('queryFailed', { message: state.system.error })}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>{t('retry')}</Button>
        </div>}
        {(['accessibility', 'screenRecording'] as const).map(permission => <div className={css.permission} key={permission}
          role="group" aria-label={t(permission)}>
          <div>
            <strong>{t(permission)}</strong>
            <PermissionDescription application={application} permission={permission} loading={loading} t={t} />
          </div>
          <PermissionAction permission={permission}
            granted={observed === null || state.system.error !== null ? null : observed[permission]}
            loading={loading} busy={busy} request={props.request} openSettings={props.openSettings} t={t} />
        </div>)}
      </div>
      <p>{t('permissionHint')}</p>
    </section>
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
    && state.value.accessibility && state.value.screenRecording
  useEffect(() => { if (ready && !state.busy) onDismiss() }, [ready, state.busy, onDismiss])
  return <Modal open={!ready && (state.value !== null || (!state.busy && state.error !== null))}
    title={t('setupTitle')} closeLabel={t('close')} onClose={onDismiss}
    footer={<>
      <Button variant="ghost" onClick={onDismiss}>{t('later')}</Button>
      <Button variant="primary" data-modal-autofocus onClick={onOpenDetails}>{t('openSetup')}</Button>
    </>}>
    <p>{t(state.error === null ? 'setupBody' : 'setupQueryFailed')}</p>
  </Modal>
}

/** @param props Shared operation outcome, independent of page lifetime. @returns The existing global toast presentation. */
export function PermissionToast(props: PermissionProps) {
  const toast = props.useCuaPermissions(value => value.toast)
  if (!toast) return null
  return <Toast key={toast.id} text={toast.kind === 'failed' ? props.t('failed', { message: toast.message }) : props.t(toast.kind)}
    {...toast.kind === 'revoked' ? { tone: 'success' as const } : {}} onDone={props.dismissToast} />
}
