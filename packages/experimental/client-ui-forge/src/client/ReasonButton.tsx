/** The info button of a status row that failed, whose tooltip gives the failure's reason. */

import type { ReactNode } from 'react'
import { IconInfoOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Forge.module.css'

/**
 * Render an info button that shows why a status row failed: after 500ms of
 * hover, at once on keyboard focus, and on a press, which touch screens need
 * because they cannot hover.
 * @param props.reason - the failure's reason, such as the host's error message.
 * @param props.label - accessible name of the button.
 * @returns the button.
 */
export function ReasonButton({ reason, label }: { readonly reason: string; readonly label: string }): ReactNode {
  return (
    <Tooltip label={reason} side="bottom" align="end" delayMs={500} maxWidth={320} openOnClick portal>
      <button type="button" className={css.reason} aria-label={label} data-forge-reason="">
        <IconInfoOutlineRegular size={16} />
      </button>
    </Tooltip>
  )
}
