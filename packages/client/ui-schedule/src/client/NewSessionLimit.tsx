/** Display the Host's effective admission interval before selecting per-run conversations. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostTaskActions } from './TaskDetail.tsx'
import css from './TaskManagerPage.module.css'

/** Read the configured interval through an injected action; failed reads stay visible and retryable.
 * @param props - The failure-contained read action and task-manager translations.
 * @returns The configured interval, a loading indicator, or a retryable failure.
 */
export function NewSessionLimit({ load, t }: PropsLocale<'schedule.manager'> & {
  readonly load: HostTaskActions['loadNewSessionInterval']
}): ReactNode {
  const [attempt, setAttempt] = useState(0)
  const [interval, setInterval] = useState<number | 'loading' | 'error'>('loading')
  useEffect(() => {
    let active = true
    setInterval('loading')
    void load().then((seconds) => {
      if (active) setInterval(seconds ?? 'error')
    })
    return () => { active = false }
  }, [load, attempt])
  if (interval === 'loading') return <div className={css.saveNotice} role="status" aria-label={t('host.limitsLoading')}><StateDot state="ongoing" /></div>
  if (interval === 'error') return <div className={css.notice}>
    <p role="alert">{t('host.limitsError')}</p>
    <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('list.retry')}</Button>
  </div>
  const unit = interval % 3_600 === 0 ? 'hour' : interval % 60 === 0 ? 'minute' : 'second'
  const value = interval / (unit === 'hour' ? 3_600 : unit === 'minute' ? 60 : 1)
  const label = new Intl.NumberFormat(t('time.locale'), { style: 'unit', unit, unitDisplay: 'long' }).format(value)
  return <p className={css.saveNotice}>{t('host.newSessionInterval', { interval: label })}</p>
}
