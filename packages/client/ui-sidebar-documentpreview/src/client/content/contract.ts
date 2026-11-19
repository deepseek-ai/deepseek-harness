/** Extension seats for caller-supplied document content. */
import type { PreviewContent } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Actions for the current caller-supplied content. */
    'sidebar.right.tab.content.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        readonly address: string
        readonly content: PreviewContent
      }
    }
  }
}
