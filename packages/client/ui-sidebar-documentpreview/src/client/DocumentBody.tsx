/**
 * The `sidebar.right.document.body` Factory: one document renderer occurrence.
 *
 * The Factory owns the keyed `sidebar.right.tab.document` declaration, so every
 * tab type that renders documents calls it instead of declaring the slot. It
 * dispatches the owner inputs to the body registered under `rendererId` and,
 * when none is registered, names the implementation from its registry
 * definition, or by its id when the definition is gone too.
 */
import type { ReactNode } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import css from './TextPreview.module.css'

/**
 * Render the selected implementation's document body.
 * @param props - owner inputs, the implementation id, the tab reader, the registry hook, and copy.
 * @returns the registered body, or the unavailable-renderer line.
 */
export function DocumentBody({
  rendererId, useTabInfo, addResource, setResources, resourceAddress, baseAddress, content, wrap, scrollportRef,
  renderSlot, useDocumentPreviews, t,
}: FactoryComponentPropsOf<'sidebar.right.document.body'>): ReactNode {
  const definition = useDocumentPreviews(definitions => definitions.find(candidate => candidate.id === rendererId))
  const owner = {
    addResource, setResources, resourceAddress, content, wrap, scrollportRef,
    ...(baseAddress === undefined ? {} : { baseAddress }),
  }
  return renderSlot('sidebar.right.tab.document', owner, {
    entryKey: rendererId, hookContext: useTabInfo,
    fallback: <p className={css.statusLine}>{t('rendererUnavailable', { name: definition?.title() ?? rendererId })}</p>,
  })
}
