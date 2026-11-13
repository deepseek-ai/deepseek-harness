import type { ReactNode } from 'react'
import { Button, IconChevronLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** A compact back control sits beside the detail title in both task and report views. */
export function DetailHeader({
  title,
  back,
  children,
  t,
}: {
  title: string
  back: () => void
  children?: ReactNode
} & PropsLocale<'timeline'>): ReactNode {
  return (
    <header className="timeline-detail-header">
      <Button
        className="timeline-icon-button"
        aria-label={t('back')}
        title={t('back')}
        data-detail-back
        onClick={back}
      >
        <IconChevronLeftOutlineRegular size={18} />
      </Button>
      <h2>{title}</h2>
      {children}
    </header>
  )
}
