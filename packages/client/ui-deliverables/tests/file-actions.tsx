/** Capture delivery action ownership without duplicating the opening-control implementation. */
import type { PropsRenderSlots, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../src/client/index.ts'

/** Slot renderer exposing the owning route and gesture for component tests. */
export const renderFileActions: PropsRenderSlots<'deliverables.file.actions' | 'deliverables.review.file.actions'>['renderSlot'] = (_name: string, input: object) => {
  const props = input as SlotMap['deliverables.file.actions']['owner']
  return props.available ? <button type="button" data-action-url={props.actionUrl} disabled={props.pending}
    onClick={() => { void props.onAction('open') }}>Native file action</button> : null
}
