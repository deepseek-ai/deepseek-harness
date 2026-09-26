import { useEffect, useRef } from 'react'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { CatalogInjected } from './catalog-source.ts'
import { ScheduleCreateCard, type ScheduleCreateCardInput, type ScheduleCreateCardProps } from './ScheduleCreateCard.tsx'
import { scheduleCreateCardModel } from './schedule-create-card.ts'
import { SCHEDULE_CREATE_TOOL, selectScheduleTasks } from './schedule-turn.ts'
import css from './ScheduleTurnCard.module.css'

/** Task navigation the turn row receives from its list registration. */
export interface ScheduleTurnCardInjected extends Pick<CatalogInjected<ScheduleCatalogEntry>, 'hooks' | 'onRetry'> {
  /**
   * Show one created task's detail in the right Sidebar.
   * @param id - Task created by this Turn.
   */
  readonly openTaskDetail: (id: ScheduleId) => void
}

/** Props of the created-task row of one Turn tail. */
export type ScheduleTurnCardProps = PropsRuntime<'conversation.chat.turnTail'>
  & InjectFace<ScheduleTurnCardInjected>
  & PropsLocale<'schedule.manager'>

/**
 * Props of one card rendered from the Turn tail.
 *
 * The keyed Tool seat also carries the owner's file opener, image loader, and
 * workspace facts; this card reads none of them, and the Turn tail supplies
 * only the fields it does.
 * @param block - settled result node recorded against the Turn.
 * @param openTaskDetail - right-Sidebar navigation for the created task.
 * @param t - the active locale's copy.
 * @returns the composed props of one `ScheduleCreateCard`.
 */
function cardProps(
  block: ToolResultNode,
  openTaskDetail: ScheduleTurnCardInjected['openTaskDetail'],
  t: ScheduleCreateCardProps['t'],
  currentTask: ScheduleCatalogEntry | null | undefined,
): ScheduleCreateCardInput {
  const supplied: ScheduleCreateCardInput = {
    callId: block.callId,
    toolName: SCHEDULE_CREATE_TOOL,
    block,
    openTaskDetail,
    t,
    ...(currentTask === undefined ? {} : { currentTask }),
  }
  return supplied
}

interface CurrentScheduleCardsProps {
  readonly created: readonly ToolResultNode[]
  readonly openTaskDetail: ScheduleTurnCardInjected['openTaskDetail']
  readonly t: ScheduleCreateCardProps['t']
  readonly useCatalog: ScheduleTurnCardProps['useCatalog']
  readonly onRetry: ScheduleTurnCardInjected['onRetry']
}

/** Created-task cards reconciled against the authoritative Host catalog. */
function CurrentScheduleCards({ created, openTaskDetail, t, useCatalog, onRetry }: CurrentScheduleCardsProps) {
  const catalog = useCatalog(snapshot => snapshot)
  // The cards carry the records their creation calls wrote, so only a read issued
  // after they appeared can state that one is gone: the retained records of an
  // earlier read may simply predate the creation. This tail requests that read
  // itself - the source batches the requests of one commit into a single read, so a
  // conversation with several created-task cards still sends one - which makes the
  // order one of cause, never a comparison of the browser's clock with the Host's.
  // The ordinal is the request the source issued, so a read sent before this tail
  // rendered cannot pass the gate even if it resolves afterwards. A failed read
  // leaves the figure, so the cards keep the created rule until a read succeeds.
  const requestAtMount = useRef(catalog.readRequest).current
  // The mount ordinal goes with the request: the source shares an in-flight read
  // only when that read was requested after this tail appeared, so a read sent
  // before it cannot answer for it.
  useEffect(() => { void onRetry(requestAtMount) }, [onRetry, requestAtMount])
  const records = catalog.settled && catalog.readSettled > requestAtMount ? catalog.records : undefined
  return created.map((block) => {
    const task = scheduleCreateCardModel(block, SCHEDULE_CREATE_TOOL).task
    const current = task === undefined || records === undefined
      ? undefined
      : records.find(record => record.id === task.id) ?? null
    return (
      <ScheduleCreateCard
        key={block.callId}
        {...cardProps(block, openTaskDetail, t, current)}
      />
    )
  })
}

/**
 * Render the tasks one Turn created as standalone cards beneath its closing
 * prose.
 *
 * The Turn tail is a list seat independent of the Turn's process disclosure,
 * so the cards stay visible while the Tool group is collapsed. Every list entry
 * renders for every Turn, so this one narrows its own Turn here.
 * @param props - closing Turn owner currency, turn-tail navigation, and copy.
 * @returns one created-task card per settled `schedule_create` result, or null when the Turn created none.
 */
export function ScheduleTurnCard(props: ScheduleTurnCardProps) {
  const matched = selectScheduleTasks(props)
  if (matched === null) return null
  return (
    <div className={css.list}>
      <CurrentScheduleCards
        created={matched.created}
        openTaskDetail={props.openTaskDetail}
        t={props.t}
        useCatalog={props.useCatalog}
        onRetry={props.onRetry}
      />
    </div>
  )
}
