/** Dispatch the selected renderer through the document Factory’s keyed slot. */
import type { ReactNode } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentBodyInput } from './document/contract.ts'
import css from './TextPreview.module.css'

/**
 * Render the selected implementation's document body.
 * @param props - owner inputs, the implementation id, the tab reader, the registry hook, and copy.
 * @returns the registered body, or the unavailable-renderer line.
 */
export function DocumentBody({
  rendererId, useTabInfo, addResource, setResources, resourceAddress, baseAddress, content, wrap, scrollportRef,
  renderSlot, useDocumentPreviews, t,
}: DocumentBodyInput & Pick<FactoryComponentPropsOf<'sidebar.right.document.body'>, 'renderSlot' | 'useDocumentPreviews' | 't'>): ReactNode {
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
