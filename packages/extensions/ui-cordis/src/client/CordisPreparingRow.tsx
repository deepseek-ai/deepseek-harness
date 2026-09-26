/** Argument-free Cordis tool prefix shared by its three card families. */
import type { ReactNode } from 'react'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'

/* v8 ignore next -- Non-expandable rows never invoke DisclosureRow's required toggle callback. */
const noop = (): void => undefined

type CordisPreparingRowProps = Pick<ToolCallViewProps, 'toolName'> & PropsLocale<'cordis'> & {
  readonly icon: ReactNode
  readonly title: string
  readonly className?: string | undefined
  readonly rowClassName?: string | undefined
  readonly titleClassName?: string | undefined
}

/**
 * Render a Cordis-owned prefix without disclosure.
 * @param props - Cordis prefix, styling, and locale.
 * @returns the preparation row.
 */
export function CordisPreparingRow({
  toolName, t, icon, title, className, rowClassName, titleClassName,
}: CordisPreparingRowProps) {
  return <div data-tool={toolName} data-state="preparing" aria-label={t('a11y.preparing')}>
    <DisclosureRow icon={icon} title={title} className={className} rowClassName={rowClassName}
      titleClassName={titleClassName} open={false} expandable={false} onToggle={noop} running />
  </div>
}
