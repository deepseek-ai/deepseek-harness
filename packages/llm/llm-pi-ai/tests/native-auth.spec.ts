import { describe, expect, it } from 'vitest'
import type { AuthContext, Provider } from '@earendil-works/pi-ai'
import { catalogProvider, catalogProviderIds } from '../src/catalog.ts'
import { nativeAuthOf } from '../src/native-auth.ts'

/** The names one resolver reads, in order, when only the names in `set` hold a value. */
async function reads(provider: Provider, set: ReadonlySet<string>): Promise<string[]> {
  const read: string[] = []
  const ctx: AuthContext = {
    env: (name) => {
      read.push(name)
      return Promise.resolve(set.has(name) ? 'probe-value' : undefined)
    },
    fileExists: () => Promise.resolve(false),
  }
  await provider.auth.apiKey?.resolve({ ctx, signal: new AbortController().signal })
  return read
}

/** Insert each name `into` lacks right after the name the resolver read before it. */
function merge(into: string[], sequence: readonly string[]): void {
  for (const [index, name] of sequence.entries()) {
    if (into.includes(name)) continue
    into.splice(index === 0 ? 0 : into.indexOf(sequence[index - 1]!) + 1, 0, name)
  }
}

describe('native authentication', () => {
  it('lists every environment variable each installed resolver reads, in lookup order', async () => {
    for (const id of catalogProviderIds()) {
      const provider = catalogProvider(id)!
      // Probe individual values and suffixes until no new names appear. A
      // suffix keeps earlier short-circuit keys unset while satisfying several
      // required values, such as Anthropic's workload identity federation.
      const names: string[] = []
      merge(names, await reads(provider, new Set()))
      let previousLength: number
      do {
        previousLength = names.length
        for (let index = 0; index < names.length; index++) {
          merge(names, await reads(provider, new Set([names[index]!])))
          merge(names, await reads(provider, new Set(names.slice(index))))
        }
      } while (names.length !== previousLength)
      expect(nativeAuthOf(provider).env, id).toEqual(names)
    }
  })
})
