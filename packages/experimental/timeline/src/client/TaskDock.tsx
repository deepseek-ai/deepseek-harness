import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconCloseOutlineRegular,
  IconRightUpOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot, PropsStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { Config } from '../config.ts'
import type { Tree } from '../records.ts'
import { measureAll } from '../tasks.ts'
import { Progress, formatProgress } from './Progress.tsx'
import type { createViewStore } from './store.ts'
import type { TreeTransferActions } from './TreeTransfer.tsx'

export interface TaskDockInjected extends Pick<TreeTransferActions, 'removeTree'> {
  hooks: {
    settings: ObservableSnapshot<ConfigFormSnapshot<Config>>
  }
  toggleSidebar: (showingTree: boolean) => void
}
type TaskDockProps = PropsRuntime<'conversation.input.dock'> &
  PropsLocale<'timeline'> &
  PropsStore<ReturnType<typeof createViewStore>> &
  InjectFace<TaskDockInjected>

/** Keep the active plan visible beside the composer using the sidebar's shared view. */
export function TaskDock({
  sessionId,
  useProjection,
  useStore,
  actions,
  useSettings,
  useSession,
  toggleSidebar,
  removeTree,
  t,
}: TaskDockProps): ReactNode {
  const view = useProjection('timeline')
  const tree = view?.trees.find(item => item.id === view.activeTreeId)
  const state = useStore(value => value)
  const settings = useSettings(value => value.value)
  const decimals = settings?.progressDecimals ?? 2
  const segmented = settings?.segmentedProgress ?? true
  const overall = useMemo(() => measureAll(tree?.tasks ?? [], segmented).get(null), [tree, segmented])
  const draft = useSession(
    value =>
      value.blank &&
      !value.running &&
      !value.awaitingFirstTurn &&
      value.pendingSubmissions.length === 0,
  )
  const [removing, setRemoving] = useState(false)
  const [failed, setFailed] = useState<{ sessionId: typeof sessionId; tree: Tree['id'] }>()
  const removeFailed = failed?.sessionId === sessionId && failed.tree === tree?.id
  const showingTree =
    tree !== undefined &&
    (state.tree ?? view?.activeTreeId) === tree.id &&
    state.tab === 'tasks' &&
    state.details.tasks.length === 0
  const toggle = (tree: Tree) => {
    actions.update({
      tree: tree.id,
      tab: 'tasks',
      details: { ...state.details, tasks: [] },
    })
    toggleSidebar(showingTree)
  }
  if (view === undefined || tree === undefined) return null
  const progress = overall?.progress ?? 0
  return (
    <section className="timeline-dock" aria-label={t('tasks')} data-current-tree={showingTree}>
      <div className="timeline-dock-bar" data-status={overall?.status ?? 'pending'}>
        <Tooltip label={tree.title} side="top" portal delayMs={500}>
          <span className="timeline-dock-title">{tree.title}</span>
        </Tooltip>
        <Progress
          value={progress}
          status={overall?.status ?? 'pending'}
          label={t('progress')}
          decimals={decimals}
          parts={overall?.parts}
          t={t}
        />
        <span className="timeline-dock-percent">{formatProgress(progress, decimals)}%</span>
        <Tooltip
          label={t('tasks')}
          side="top"
          align="end"
          portal
          delayMs={500}
        >
          <Button size="sm" className="timeline-dock-action" onClick={() => { toggle(tree) }}>
            <span className="timeline-dock-label timeline-dock-open">{t('openTaskTree')}</span>
            <span className="timeline-dock-label timeline-dock-close">{t('closeTaskTree')}</span>
            <IconRightUpOutlineRegular size={16} />
          </Button>
        </Tooltip>
        {draft ? (
          <Tooltip label={t(removeFailed ? 'draftRemoveFailed' : 'removeDraftTree')} side="top" portal>
            <Button
              size="sm"
              className="timeline-dock-action"
              aria-label={t(removeFailed ? 'draftRemoveFailed' : 'removeDraftTree')}
              disabled={removing}
              onClick={() => {
                setRemoving(true)
                setFailed(undefined)
                void removeTree(tree.id)
                  .then(() => { actions.forgetTree(tree.id) })
                  .catch(() => { setFailed({ sessionId, tree: tree.id }) })
                  .finally(() => { setRemoving(false) })
              }}
            >
              <IconCloseOutlineRegular size={16} />
            </Button>
          </Tooltip>
        ) : null}
      </div>
    </section>
  )
}
