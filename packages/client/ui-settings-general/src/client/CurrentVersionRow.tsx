/** Installed release version in General Settings, with hidden 5-click unlock in Desktop. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { DesktopChannelSource } from './desktop-channel-source.ts'
import css from './CurrentVersionRow.module.css'

const UNLOCK_CLICKS_REQUIRED = 5

/** Channel observation and optional Desktop unlock action injected into CurrentVersionRow. */
export interface CurrentVersionRowInjected {
  hooks: { channel: DesktopChannelSource['store'] }
  unlock?: () => Promise<void>
}

/** Props for CurrentVersionRow in Web (inactive channel store, no unlock) and Desktop (live channel store + unlock). */
export type CurrentVersionRowProps =
  PropsRuntime<'settings.general.group.updates.item'> &
  PropsLocale<'settings'> &
  InjectFace<CurrentVersionRowInjected>

/**
 * Render the version embedded by the client build; clicking 5 times in Desktop opens the unlock confirmation.
 * @param props - runtime share, localized copy, and channel observation with optional Desktop unlock controls.
 * @returns the current release label and confirmation modal, or nothing when build metadata is absent.
 */
export function CurrentVersionRow({ t, useChannel, unlock }: CurrentVersionRowProps) {
  const snapshot = useChannel(value => value)
  const [clicks, setClicks] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const version = process.env.DSH_CLIENT_VERSION
  if (version === undefined) return null
  const state = snapshot.state
  const canUnlock = unlock !== undefined
    && state !== undefined
    && !state.unlocked
    && !state.changing
    && state.error === undefined
    && snapshot.pending === undefined
    && !snapshot.failed
  const dismiss = (): void => { setConfirming(false) }
  return (
    <>
      <div
        className={css.row}
        onClick={canUnlock ? () => {
          const next = clicks + 1
          if (next >= UNLOCK_CLICKS_REQUIRED) {
            setClicks(0)
            setConfirming(true)
          } else {
            setClicks(next)
          }
        } : undefined}
      >
        {t('general.currentVersion', { version })}
      </div>
      {canUnlock && (
        <Modal
          open={confirming}
          tone="warning"
          title={t('desktop.channel.unlock.title')}
          description={t('desktop.channel.unlock.description')}
          closeLabel={t('close')}
          onClose={dismiss}
          backdropBlur={false}
          footer={(
            <>
              <Button variant="outline" data-modal-autofocus onClick={dismiss}>
                {t('desktop.channel.unlock.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirming(false)
                  void unlock()
                }}
              >
                {t('desktop.channel.unlock.confirm')}
              </Button>
            </>
          )}
        />
      )}
    </>
  )
}
