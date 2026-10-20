/** Extension positions below the subagent catalog in each header entry. */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Content below the root Session's subagent tree. */
    'conversation.session.header.actions.subagent.footer': {
      kind: 'list'
      scope: 'session'
    }
    /** Content below a descendant's sibling or child tree. */
    'conversation.session.header.lineage.subagent.footer': {
      kind: 'list'
      scope: 'session'
    }
  }
}

export {}
