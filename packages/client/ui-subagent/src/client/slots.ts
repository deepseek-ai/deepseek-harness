/** Extension position below the Session panel's subagent tree. */
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Content below the Session's subagent tree in the Session panel, such as the shared task board. */
    'conversation.session.panel.subagents.footer': {
      kind: 'list'
      scope: 'session'
    }
  }
}

export {}
