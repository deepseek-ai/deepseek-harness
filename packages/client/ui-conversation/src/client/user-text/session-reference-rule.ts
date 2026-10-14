/** Original-text Session candidates with explicit wire spelling and longest known labels. */
import type { UserTextRule, UserTextNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    session: { readonly label: string }
  }
  interface UserTextFacts {
    sessionLabels: readonly string[]
  }
}

/** Find the nearest Session reference; bare labels read their Facts only at a non-wire @ position. */
export const sessionReferenceRule: UserTextRule<'session'> = {
  id: 'session',
  order: 10,
  match(text, from, context) {
    let labels: readonly string[] | undefined
    let readLabels = false
    const wire = /@\[([^\]\n]+)\]\(dsh-session:[^)\s]+\)/uy
    for (let start = text.indexOf('@', from); start >= 0; start = text.indexOf('@', start + 1)) {
      wire.lastIndex = start
      const explicit = wire.exec(text)
      if (explicit !== null) return {
        id: 'session', start, end: start + explicit[0].length, data: { label: explicit[1] as string },
      }
      if (!readLabels) {
        labels = context.read('sessionLabels')
        readLabels = true
      }
      let best: UserTextNode<'session'> | undefined
      for (const label of labels ?? []) {
        if (label.length === 0 || !text.startsWith(label, start + 1)) continue
        const end = start + label.length + 1
        if (best === undefined || end > best.end) best = { id: 'session', start, end, data: { label } }
      }
      if (best !== undefined) return best
    }
    return undefined
  },
}
