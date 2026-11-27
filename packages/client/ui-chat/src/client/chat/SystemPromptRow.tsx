import { memo, useState } from 'react'
import type { ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import { DisclosureRow, IconBrowseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { SystemMessageSections } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { OpaqueBody, SystemSectionsBody } from './ContextBody.tsx'
import css from './ContextInjectionRow.module.css'

/** Props for one complete system prompt disclosure. */
export interface SystemPromptRowProps {
  /** Complete model-visible prompt text. */
  text: string
  /** True when the prompt replaced an earlier one from this position in the history. */
  update?: boolean
  /** Section-attributed reading of an update; without it the body is the opaque text. */
  message?: SystemMessageSections | undefined
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/**
 * Render one complete system prompt as a collapsed disclosure whose expanded
 * body is the same opaque context chrome: 141px code-block scrollport and
 * model-facing text with its real line breaks. An in-history update uses the
 * same row under its own title; one carrying section metadata names its sources
 * beside the title and splits the body by source.
 * @param props - Prompt text, whether it is an update, its section reading, and the locale seat.
 * @returns The system-prompt disclosure row.
 */
export function SystemPromptRow({ text, update = false, message, t }: SystemPromptRowProps) {
  const [open, setOpen] = useState(false)
  const names = message?.changes.map(change => change.name) ?? []
  // Up to two sources are named in the row; more are counted.
  const summary = names.length > 2 ? t('message.systemPromptSections', { count: names.length }) : names.join(', ')
  return (
    <DisclosureRow
      className={css.root}
      icon={<IconBrowseOutlineRegular size={14} />}
      chevronClassName={css.chevron}
      title={t(update ? 'message.systemPromptUpdate' : 'message.systemPrompt')}
      collapsedContent={summary === '' ? undefined : (
        <>
          <span className={css.sep} aria-hidden />
          <span className={css.summary} data-system-sources>{summary}</span>
        </>
      )}
      keepContentWhenOpen
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <div className={css.body} data-system-prompt-body>
        {message === undefined
          ? <OpaqueBody content={[{ type: 'text', text }]} source={null} t={t} />
          : <SystemSectionsBody message={message} t={t} />}
      </div>
    </DisclosureRow>
  )
}

/** System-prompt keyed Chat renderer. */
export const SystemPromptNodeView = memo(function SystemPromptNodeView({
  node, t,
}: Pick<ChatNodeViewProps<'system-prompt'>, 'node' | 't'>) {
  return <SystemPromptRow text={node.data.text} update={node.data.update === true} message={node.data.message} t={t} />
})
