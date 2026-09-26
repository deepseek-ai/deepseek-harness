/** Native file-action contribution shared by delivery cards and change review. */
import type { PresentedOpenFailure } from './present-open.ts'
import type { PresentedAction } from '../presented.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Open one file through its authorized Session event coordinates. */
    'deliverables.file.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        /** Authenticated document-relative action route carrying Session event coordinates. */
        readonly actionUrl: string
        readonly available: boolean
        readonly pending: boolean
        /** Execute the selected native action and publish status on the owning file surface. */
        readonly onAction: (action: PresentedAction, application?: string) => Promise<PresentedOpenFailure>
      }
    }
    /** The same file actions owned by a changed-file review tab. */
    'deliverables.review.file.actions': {
      kind: 'list'
      scope: 'session'
      owner: SlotMap['deliverables.file.actions']['owner']
    }
  }
}
