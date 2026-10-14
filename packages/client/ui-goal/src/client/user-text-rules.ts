/** Original-text command candidates restricted to confirmed execution ranges. */
import type { UserTextRule, UserTextNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** The executed command name, without the leading slash. */
    command: { readonly name: string }
  }

  interface UserTextFacts {
    /** Confirmed command ranges; repeated command spelling outside them stays plain text. */
    readonly commands: readonly { readonly start: number; readonly end: number; readonly name: string }[]
  }
}

/** Return the nearest exact confirmed command, checking boundaries against the original string. */
export const goalCommandReferenceRule: UserTextRule<'command'> = {
  id: 'command',
  order: 20,
  match(text, from, context) {
    const slash = /(?<!\S)\//gu
    slash.lastIndex = from
    if (!slash.test(text)) return undefined
    const commands = context.read('commands')
    let best: UserTextNode<'command'> | undefined
    for (const { start, end, name } of commands ?? []) {
      if (start < from || end > text.length || text.slice(start, end) !== `/${name}`
        || (start !== 0 && !/\s/u.test(text.slice(start - 1, start)))
        || (end !== text.length && !/\s/u.test(text.slice(end, end + 1)))) continue
      if (best === undefined || start < best.start || (start === best.start && end > best.end)) {
        best = { id: 'command', start, end, data: { name } }
      }
    }
    return best
  },
}
