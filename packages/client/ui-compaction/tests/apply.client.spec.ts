import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

async function boot() {
  const ctx = new Context()
  const openResource = vi.fn()
  const register = vi.fn(() => () => {})
  ctx.provide('locale', { bind: () => (key: string) => key, register } as never)
  ctx.provide('remote', { session: {} } as never)
  ctx.provide('remote.session', {} as never)
  ctx.provide('resources', { register } as never)
  ctx.provide('sidebarRight', { openResource } as never)
  const registerTab = vi.fn((_type: SidebarRightTabDefinition) => () => {})
  ctx.provide('sidebarRightTabs', { register: registerTab } as never)
  const registerSlot = vi.fn(() => () => {})
  ctx.provide('slots', { register: registerSlot, inject: (_key: string, mount: () => () => void) => mount() } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()
  return { ctx, openResource, registerTab, registerSlot }
}

const sessionId = brandString<SessionId>('session/1')
const childId = brandString<SessionId>('child/2')

describe('compaction summary navigation', () => {
  it('opens durable addresses for ordinary and delegated Sessions only while document previews are available', async () => {
    const { ctx, openResource, registerTab, registerSlot } = await boot()
    expect(ctx.get('compactionPreviews')).toBeUndefined()
    const withdraw = ctx.provide('documentPreviews', {} as never)
    await vi.waitFor(() => { expect(ctx.get('compactionPreviews')).toBeDefined() })
    const definition = registerTab.mock.calls[0]![0]
    expect(definition.title('')).toBe('preview.title')
    expect(definition.canOpen?.('dsh-resource://compaction/s/7')).toBe(true)
    expect(definition.canOpen?.('dsh-resource://file/s/file.md')).toBe(false)
    expect(registerSlot).toHaveBeenCalledTimes(2)
    const preview = ctx.compactionPreviews
    const address = { kind: 'session' as const, sessionId }
    expect(await preview.open(address, 7, AbortSignal.abort())).toBeNull()
    expect(openResource).not.toHaveBeenCalled()
    const signal = new AbortController().signal
    expect(await preview.open(address, 7, signal)).toBeNull()
    expect(openResource).toHaveBeenLastCalledWith('dsh-resource://compaction/session%2F1/7')
    await preview.open({ kind: 'subagent', parentSessionId: sessionId, childSessionId: childId, mode: 'continuable' }, 9, signal)
    expect(openResource).toHaveBeenLastCalledWith('dsh-resource://compaction/subagent/session%2F1/child%2F2/continuable/9')
    withdraw()
    await vi.waitFor(() => { expect(ctx.get('compactionPreviews')).toBeUndefined() })
    await preview.open(address, 7, signal)
    expect(openResource).toHaveBeenCalledTimes(2)
  })
})
