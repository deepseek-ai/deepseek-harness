/** Desktop channel selection; persistence and updater transitions remain in Electron. */
import { useState } from 'react'
import { Menu, Toast, IconWarningOutlineRegular, IconLoadingOutlineRegular, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopChannelSource } from './desktop-channel-source.ts'
import type { DesktopUpdateChannel } from '../types.ts'
import css from './DesktopChannelRow.module.css'

/** Framework-bound shell state and explicit selection action. */
export interface DesktopChannelRowInjected {
  hooks: { channel: DesktopChannelSource['store'] }
  select(channel: DesktopUpdateChannel): Promise<void>
}

/**
 * Render the Desktop-only channel control without depending on a Host settings service.
 * @param props - Shell observation, selection action and localized copy.
 * @returns The General settings row.
 */
export function DesktopChannelRow({ useChannel, select, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & InjectFace<DesktopChannelRowInjected>) {
  const { state, failed, pending } = useChannel(value => value)
  const [open, setOpen] = useState(false)
  const busy = pending !== undefined || state?.changing === true
  const channel = pending ?? state?.channel
  return <div className={css.row} role="group" aria-label={t('desktop.channel.title')}>
    <div className={css.rowText}>
      <div className={css.title}>{t('desktop.channel.title')}</div>
      <div className={css.description}>{t('desktop.channel.description')}</div>
      {(failed || state?.error !== undefined) && <div role="alert">{t(failed ? 'desktop.channel.readError' : 'desktop.channel.error')}</div>}
    </div>
    <Menu open={open} onClose={() => { setOpen(false) }} portal align="end"
      selectedId={channel ?? ''}
      items={[{ id: 'stable', label: t('desktop.channel.stable') }, { id: 'nightly', label: t('desktop.channel.nightly') }]}
      onSelect={(id) => {
        setOpen(false)
        void select(id as DesktopUpdateChannel)
      }}
      anchor={<button type="button" className={css.selector} disabled={busy || state === undefined}
        aria-busy={busy} aria-label={t('desktop.channel.title')} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(!open) }}>
        {channel === undefined || channel === null
          ? t('desktop.channel.unavailable') : t(channel === 'stable' ? 'desktop.channel.stable' : 'desktop.channel.nightly')}
        {busy ? <IconLoadingOutlineRegular className={css.spinner} /> : <IconChevronDownOutlineRegular className={css.chevron} />}
      </button>} />
  </div>
}

/** Shell-owned operation feedback that survives closing Settings. */
export interface DesktopChannelToastInjected {
  hooks: { channel: DesktopChannelSource['store'] }
  dismiss(sequence: number): void
  openConfiguration(): void
}

/**
 * Render the latest channel save result outside Settings.
 * @param props - Shared operation state, dismissal and localized copy.
 * @returns A transient toast, or nothing.
 */
export function DesktopChannelToast({ useChannel, dismiss, openConfiguration, t }:
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings'> & InjectFace<DesktopChannelToastInjected>) {
  const notice = useChannel(value => value.notice)
  if (notice === undefined) return null
  return <Toast key={notice.sequence} text={t(`desktop.channel.result.${notice.outcome}`)}
    {...notice.outcome === 'configuration' ? { holdMs: 10_000,
      actions: [{ label: t('desktop.channel.details'), onClick: openConfiguration }] } : {}}
    onDone={() => { dismiss(notice.sequence) }} {...notice.outcome === 'applied' ? { tone: 'success' as const } : { icon: <IconWarningOutlineRegular /> }} />
}
