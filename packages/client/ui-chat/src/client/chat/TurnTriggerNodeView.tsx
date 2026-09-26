/** An independent, expandable notice explaining a non-human Turn trigger. */
import { useId, useState, type ComponentType } from 'react'
import {
  IconAgentPresetOutlineRegular, IconAlarmClockOutlineRegular, IconBranchOutlineRegular,
  IconChevronDownOutlineRegular, IconContextInjectionOutlineRegular, IconCordisPluginOutlineRegular,
  IconGoalOutlineRegular, IconGlobeOutlineRegular, IconPaperPlaneOutlineRegular, IconQueueOutlineRegular,
  type IconProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { formatMessageClock } from './message-chrome.ts'
import { NoticeBody } from './ContextBody.tsx'
import { turnTriggerDetails, type TurnTriggerIcon } from './turn-trigger.ts'
import css from './TurnTriggerNodeView.module.css'

const TRIGGER_ICONS: Record<TurnTriggerIcon, ComponentType<IconProps>> = {
  request: IconContextInjectionOutlineRegular,
  goal: IconGoalOutlineRegular,
  agent: IconPaperPlaneOutlineRegular,
  team: IconAgentPresetOutlineRegular,
  subagent: IconAgentPresetOutlineRegular,
  github: IconBranchOutlineRegular,
  webhook: IconGlobeOutlineRegular,
  schedule: IconAlarmClockOutlineRegular,
  job: IconQueueOutlineRegular,
  plugin: IconCordisPluginOutlineRegular,
}

/** Render recorded trigger attribution above the whole-Turn disclosure. */
export function TurnTriggerNodeView({ node, t }: Pick<ChatNodeViewProps<'turn-trigger'>, 'node' | 't'>) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const details = turnTriggerDetails(node.data)
  const TriggerIcon = TRIGGER_ICONS[details.icon]
  const date = new Date(node.data.time)
  const time = formatMessageClock(node.data.time, t)
  return (
    <section className={css.root} data-turn-trigger>
      <button className={css.header} type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => { setOpen(!open) }}>
        <span className={css.icon} aria-hidden><TriggerIcon size={14} /></span>
        <span className={css.title}>{t(details.title)}</span>
        <time className={css.time} dateTime={date.toISOString()}>{time}</time>
        <IconChevronDownOutlineRegular size={12} className={open ? css.openChevron : css.chevron} />
      </button>
      {open && <div id={bodyId} className={css.body}>
        <p className={css.explanation}>{t('message.trigger.explanation')}</p>
        <div className={css.content}><NoticeBody content={node.data.content} source={node.data.source} t={t} /></div>
      </div>}
    </section>
  )
}
