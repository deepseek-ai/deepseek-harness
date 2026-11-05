import { expect, it } from 'vitest'
import { menuTargetKey } from '../src/client/target-key.ts'
import type { ContextMenuTarget } from '../src/client/types.ts'

declare module '@deepseek-ai/dsh-client-ui-context-menu/client' {
  interface ContextMenuTargetMap { nested: { id: string; data: { a: number; b: readonly (string | null)[] } } }
}

it('compares JSON targets independently of object key insertion order while preserving arrays', () => {
  const first: ContextMenuTarget = { kind: 'nested', value: { id: 'a', data: { a: 1, b: ['x', null] } } }
  const second: ContextMenuTarget = { value: { data: { b: ['x', null], a: 1 }, id: 'a' }, kind: 'nested' }
  expect(menuTargetKey(first)).toBe(menuTargetKey(second))
  expect(menuTargetKey(first)).not.toBe(menuTargetKey({ kind: 'nested', value: { id: 'a', data: { a: 1, b: [null, 'x'] } } }))
})
