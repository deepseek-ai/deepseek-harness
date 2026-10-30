/**
 * The text preview's layout: an optional banner, the path header, and the
 * content row, with the workspace navigator Factories in fixed positions.
 *
 * Every preview state renders this one Component, so the navigator, its
 * header toggle, and the file handoff keep their DOM nodes, focus, and scroll position while the
 * preview moves between unsupported, loading, and text. The two Factory
 * positions are memoized Components whose props are only the tab hook and
 * `renderFactorySlot`; a preview-only update, such as a recorded scroll,
 * does not re-render them.
 */
import { memo, useCallback } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type { ContextMenuTriggerProps } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TextPreview.module.css'

/** The inputs both navigator Factory positions render from. */
type NavigatorSeatProps = Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useTabInfo'> & PropsRenderFactories

/** The workspace navigator after the preview's content. */
const NavigatorSeat = memo(function NavigatorSeat({ useTabInfo, renderFactorySlot }: NavigatorSeatProps): ReactNode {
  const { tab } = useTabInfo()
  const onOpen = useCallback((address: string): void => {
    tab.actions.openResource(address, { replaceTab: true })
  }, [tab.actions])
  return renderFactorySlot('sidebar.files.navigator', { useTabInfo, page: false, onOpen })
})

/** The navigator's toggle at the header's end. */
const NavigatorToggleSeat = memo(function NavigatorToggleSeat({ useTabInfo, renderFactorySlot }: NavigatorSeatProps): ReactNode {
  return renderFactorySlot('sidebar.files.navigator.toggle', { useTabInfo })
})

/**
 * Props of {@link PreviewFrame}. `banner`, `tools`, `handoff`, and `children` are
 * ReactNode values passed between Components of this package; no slot owner
 * data or injected member carries them.
 */
export type PreviewFrameProps = NavigatorSeatProps & {
  /** The path the header shows. */
  readonly path: string
  /** Context menu handlers bound to the header path. */
  readonly pathTrigger: ContextMenuTriggerProps
  /** A notice above the header. */
  readonly banner?: ReactNode
  /** Controls between the path and the file handoff. */
  readonly tools?: ReactNode
  /** The contributions that hand the file to the Host, in the same position in every state, before the navigator toggle. */
  readonly handoff?: ReactNode
  /** The content before the navigator. */
  readonly children: ReactNode
  /** Data attributes forwarded to the root element. */
  readonly [attribute: `data-${string}`]: string | undefined
}

/**
 * The text preview's layout for every preview state.
 * @param props - the header and content parts, the navigator inputs, and the root's data attributes.
 * @returns the preview root.
 */
export function PreviewFrame({
  path, pathTrigger, banner, tools, handoff, children, useTabInfo, renderFactorySlot, ...data
}: PreviewFrameProps): ReactNode {
  return (
    <div className={css.preview} {...data}>
      {banner}
      <div className={css.header}>
        <PathLabel path={path} className={css.path} data-textpreview-path {...pathTrigger} />
        {tools}
        {handoff}
        <NavigatorToggleSeat useTabInfo={useTabInfo} renderFactorySlot={renderFactorySlot} />
      </div>
      <div className={css.content} data-textpreview-content>
        {children}
        <NavigatorSeat useTabInfo={useTabInfo} renderFactorySlot={renderFactorySlot} />
      </div>
    </div>
  )
}
