/** App-owned portals keep Office state while sidebar bodies detach. */
import { useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots/client'
import { FrameForwardingAttempt } from './Preview.tsx'
import type { RetainedOfficeView } from './retained-views.ts'

type Props = InjectFace<{ readonly hooks: { readonly views: ObservableSnapshot<readonly RetainedOfficeView[]> } }>

function HeldAttempt({ view }: { readonly view: RetainedOfficeView }): ReactNode {
  const useTabInfo = useCallback(() => {
    const info = view.props.useTabInfo()
    return { ...info, tab: { ...info.tab, visible: view.attached && info.tab.visible } }
  }, [view.props.useTabInfo, view.attached])
  const revision = view.props.content.kind === 'renderer' ? view.props.content.revision : 0
  return <FrameForwardingAttempt key={`${view.props.resourceAddress}:${revision}`} {...view.props} useTabInfo={useTabInfo} />
}

/** Render each Office occurrence into its stable target, including detached hidden bodies.
 * @param props - Framework-bound hook for the retained Office bodies.
 * @returns Portals whose lifetime follows the tab occurrence.
 */
export function RetainedViews({ useViews }: Props): ReactNode {
  const held = useViews(views => views)
  return held.map(view => createPortal(<HeldAttempt view={view} />, view.target, String(view.key)))
}
