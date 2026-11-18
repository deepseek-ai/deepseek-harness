/**
 * Header controls shared by the file and content previews: the renderer menu
 * and the line-wrap toggle. Both read this package's copy namespace.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { IconNowrapFillRegular, IconWrapFillRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DocumentPreviewDefinition } from './index.ts'
import css from './TextPreview.module.css'

/**
 * The open-with menu: an anchor naming the selected renderer, listing every candidate.
 * @param props - the candidates, the selected one, the choice callback, and copy.
 * @returns the anchor and its menu.
 */
export function RendererMenu({ candidates, selected, onSelect, t }: {
  readonly candidates: readonly DocumentPreviewDefinition[]
  readonly selected: DocumentPreviewDefinition
  readonly onSelect: (rendererId: string) => void
  readonly t: TranslateNS<'sidebarDocumentPreview'>
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      anchor={(
        <button type="button" className={clsx(css.tool, css.viewerTool)} aria-label={t('openWith')} title={selected.title()} data-document-viewer-menu onClick={() => { setOpen(value => !value) }}>
          {selected.title()}
        </button>
      )}
      items={candidates.map(candidate => ({ id: candidate.id, label: candidate.title() }))}
      selectedId={selected.id}
      onSelect={(id) => { onSelect(id); setOpen(false) }}
      onClose={() => { setOpen(false) }}
      align="end"
      portal
      dense
    />
  )
}

/**
 * The line-wrap toggle. The tooltip names the action while the stable aria
 * name and `aria-pressed` expose the control and its current state.
 * @param props - the current wrap, the toggle callback, copy, and data attributes for the button.
 * @returns the toggle with its tooltip.
 */
export function WrapToggle({ wrap, onToggle, t, ...data }: {
  readonly wrap: boolean
  readonly onToggle: () => void
  readonly t: TranslateNS<'sidebarDocumentPreview'>
  readonly [attribute: `data-${string}`]: string | undefined
}): ReactNode {
  return (
    <Tooltip label={t(wrap ? 'wrap.disable' : 'wrap.enable')} side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.tool}
        aria-pressed={wrap}
        aria-label={t('wrap.aria')}
        {...data}
        onClick={onToggle}
      >
        {wrap ? <IconNowrapFillRegular /> : <IconWrapFillRegular />}
      </button>
    </Tooltip>
  )
}
