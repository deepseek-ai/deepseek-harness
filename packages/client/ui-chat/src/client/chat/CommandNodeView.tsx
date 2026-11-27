import type { CompactionRowInjected } from './CompactionItem.tsx'
import { memo, useMemo } from 'react'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {
  ChatNodeViewProps, CommandRowOwnerProps,
} from '../contract/slots.ts'
import { CompactionCommandCard } from './CompactionCommandCard.tsx'
import { GenericCommandCard } from './GenericCommandCard.tsx'
import css from './ChatView.module.css'

type CommandNodeViewProps = ChatNodeViewProps<'command'> & PropsRenderSlots<'conversation.chat.commandview'>

/** Ordinary command lifecycle renderer with command-name keyed specialization. */
export const CommandNodeView = memo(function CommandNodeView({ node, renderSlot, t }: CommandNodeViewProps) {
  const command = node.data
  const owner = useMemo<CommandRowOwnerProps>(() => ({ node: command }), [command])
  return (
    <div className={css.callRow}>
      {renderSlot('conversation.chat.commandview', owner, {
        entryKey: command.name ?? '',
        fallback: <GenericCommandCard {...owner} t={t} />,
      })}
    </div>
  )
})

/** One integrated `/compact` command and compaction transaction renderer. */
export const ManualCompactionNodeView = memo(function ManualCompactionNodeView({
  node, openCompaction, useCompactionPreview, t,
}: ChatNodeViewProps<'manual-compaction'> & InjectFace<CompactionRowInjected>) {
  const available = useCompactionPreview(value => value)
  const data = node.data
  return (
    <div className={css.callRow}>
      <CompactionCommandCard
        node={data.command}
        {...data.compaction === null ? {} : { compaction: data.compaction }}
        openCompaction={available ? openCompaction : undefined}
        t={t}
      />
    </div>
  )
})
