/** Desktop channel selection; persistence and updater transitions remain in Electron. */
import { useState } from 'react'
import { Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
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
  const { state, failed } = useChannel(value => value)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const busy = saving || state?.changing === true
  return <div className={css.row} role="group" aria-label={t('desktop.channel.title')}>
    <div className={css.rowText}>
      <div className={css.title}>{t('desktop.channel.title')}</div>
      <div className={css.description}>{t('desktop.channel.description')}</div>
      {(failed || state?.error !== undefined) && <div role="alert">{t('desktop.channel.error')}</div>}
    </div>
    <Menu open={open} onClose={() => { setOpen(false) }} portal align="end"
      selectedId={state?.channel ?? ''}
      items={[{ id: 'latest', label: t('desktop.channel.latest') }, { id: 'nightly', label: t('desktop.channel.nightly') }]}
      onSelect={(id) => {
        setOpen(false)
        setSaving(true)
        void select(id as DesktopUpdateChannel).finally(() => { setSaving(false) })
      }}
      anchor={<button type="button" className={css.selector} disabled={busy || state === undefined}
        aria-label={t('desktop.channel.title')} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(!open) }}>
        {busy ? t('desktop.channel.changing') : state?.channel === undefined || state.channel === null
          ? t('desktop.channel.unavailable') : t(state.channel === 'latest' ? 'desktop.channel.latest' : 'desktop.channel.nightly')}
        <IconChevronDownOutlineRegular className={css.chevron} />
      </button>} />
  </div>
}
