import { expect, it } from 'vitest'
import { buttonTargetKey, menuTargetKey } from '../src/client/target-key.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ContextMenuTarget } from '../src/client/types.ts'

declare module '@deepseek-ai/dsh-client-ui-context-menu/client' {
  interface ContextMenuTargetMap { nested: { id: string; data: { a: number; b: readonly (string | null)[] } } }
}

it('compares JSON targets independently of object key insertion order while preserving arrays', () => {
  const first: ContextMenuTarget = { kind: 'nested', value: { id: 'a', data: { a: 1, b: ['x', null] } } }
  const second: ContextMenuTarget = { value: { data: { b: ['x', null], a: 1 }, id: 'a' }, kind: 'nested' }
  expect(menuTargetKey(first)).toBe(menuTargetKey(second))
  expect(buttonTargetKey(first)).toBe(menuTargetKey(second))
  expect(menuTargetKey(first)).not.toBe(menuTargetKey({ kind: 'nested', value: { id: 'a', data: { a: 1, b: [null, 'x'] } } }))
})

it('keeps entity button identity through display and path changes without changing gesture equality', () => {
  const sessionId = SessionId('one'), workspaceId = 'one' as WorkspaceId
  const before: ContextMenuTarget = { kind: 'session', value: { sessionId, displayTitle: 'Before' } }
  const after: ContextMenuTarget = { kind: 'session', value: { sessionId, displayTitle: 'After' } }
  expect(buttonTargetKey(before)).toBe(buttonTargetKey(after))
  expect(menuTargetKey(before)).not.toBe(menuTargetKey(after))
  expect(buttonTargetKey(before)).not.toBe(buttonTargetKey({ kind: 'sessionHeader', value: { sessionId } }))
  expect(buttonTargetKey({ kind: 'workspace', value: { workspaceId, path: '/before', displayTitle: 'Before' } }))
    .toBe(buttonTargetKey({ kind: 'workspace', value: { workspaceId, path: '/after', displayTitle: 'After' } }))
})
