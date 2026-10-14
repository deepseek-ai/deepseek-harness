/** Original-text skill candidates restricted to caller-confirmed names. */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** A skill name confirmed for this message, without the leading slash. */
    skill: { readonly name: string }
  }

  interface UserTextFacts {
    /** Resolved skill names; absence supplies no skill references. */
    readonly skillNames: readonly string[]
  }
}

/** Return one nearest confirmed slash token, retaining its original word boundaries. */
export const skillReferenceRule: UserTextRule<'skill'> = {
  id: 'skill',
  order: 20,
  match(text, from, context) {
    const tokens = /(?<!\S)\/([\w-]+)(?!\S)/gu
    tokens.lastIndex = from
    let names: readonly string[] | undefined
    for (let token = tokens.exec(text); token !== null; token = tokens.exec(text)) {
      if (names === undefined) {
        names = context.read('skillNames')
        if (names === undefined || names.length === 0) return undefined
      }
      const name = token[1] as string
      if (names.includes(name)) return {
        id: 'skill', start: token.index, end: token.index + token[0].length, data: { name },
      }
    }
    return undefined
  },
}
