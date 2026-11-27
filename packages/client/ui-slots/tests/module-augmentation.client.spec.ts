/**
 * Repository code augments ui-slots through its `/client` subpath, the module that declares the interface, and
 * every importer of `/client` reads the merged interface. The published-package consumer check covers the package-root
 * spelling and mixed spellings.
 */
import { expect, it } from 'vitest'
import { resolveSlotLabel, type SlotMap } from '@deepseek-ai/dsh-client-ui-slots/client'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    'augmentation.client': { kind: 'single'; scope: 'root' }
  }
}

type Expect<T extends true> = T

export type ClientSpecifierSeesTheMerge = Expect<'augmentation.client' extends keyof SlotMap ? true : false>
export type MergedEntry = Expect<SlotMap['augmentation.client'] extends { kind: 'single'; scope: 'root' } ? true : false>

it('reads ui-slots values through the /client subpath', () => {
  expect(resolveSlotLabel(() => 'label')).toBe('label')
})
