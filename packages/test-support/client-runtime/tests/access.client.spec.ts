/** Fixed-answer access stand-ins: the `remoteAccess` service and the plugin that installs it with the global Hook. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'
import type { RootStandardSourceContribution } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, vi } from 'vitest'
import { allowAllAccess, allowAllAccessPlugin, StaticRemoteAccess, staticAccessPlugin } from '../src/access.ts'

/** An endpoint the access stand-ins answer; the stand-ins read only its string. */
const GUARDED = 'session/list' as RemoteEndpoint

describe('StaticRemoteAccess', () => {
  it('answers each action once for every resource and installs only an allowed action\'s effects in the caller', async () => {
    const root = new Context()
    const allows = vi.fn((action: string) => action === GUARDED)
    new StaticRemoteAccess(root, allows)
    expect(root.remoteAccess.source('session', 's1', GUARDED).getSnapshot()).toBe(true)
    expect(root.remoteAccess.source('session', 's1', 'session/fork').getSnapshot()).toBe(false)
    // Fixed answers never notify.
    for (const action of [GUARDED, 'session/fork']) {
      const listener = vi.fn()
      root.remoteAccess.source('session', 's1', action).subscribe(listener)()
      expect(listener).not.toHaveBeenCalled()
    }

    const allowedDispose = vi.fn()
    const refused = vi.fn(() => () => {})
    let stopAllowed = (): void => {}
    let stopRefused = (): void => {}
    const caller = root.plugin({
      inject: ['remoteAccess'],
      apply: (ctx: Context) => {
        stopAllowed = ctx.remoteAccess.whenResourceAccess('session', 's1', GUARDED, () => allowedDispose)
        stopRefused = ctx.remoteAccess.whenAccess('session/fork', refused)
      },
    })
    await caller.await()
    expect(refused).not.toHaveBeenCalled()
    expect(() => { stopRefused() }).not.toThrow()
    stopAllowed()
    await vi.waitFor(() => { expect(allowedDispose).toHaveBeenCalledOnce() })
    await caller.dispose()
    await root.fiber.dispose()
  })
})

describe('allow-all access', () => {
  it('allows every action through the props Hooks and a predicate-less service', async () => {
    expect([
      allowAllAccess.useRemoteAccess(GUARDED),
      allowAllAccess.useAccess(GUARDED),
      allowAllAccess.useSessionAccess('s1' as Parameters<typeof allowAllAccess.useSessionAccess>[0], GUARDED),
      allowAllAccess.useWorkspaceAccess('w1' as Parameters<typeof allowAllAccess.useWorkspaceAccess>[0], GUARDED),
    ]).toEqual([true, true, true, true])
    const root = new Context()
    new StaticRemoteAccess(root)
    expect(root.remoteAccess.source('workspace', 'w1', 'workspace/follow').getSnapshot()).toBe(true)
    await root.fiber.dispose()
  })
})

describe('staticAccessPlugin', () => {
  it('provides the fixed-answer service and the matching global-resource Hook', async () => {
    const root = new Context()
    let contribution: RootStandardSourceContribution | undefined
    root.provide('slots', { provideRoot: (value: RootStandardSourceContribution) => { contribution = value; return () => {} } } as never)
    await root.plugin(staticAccessPlugin(action => action === GUARDED)).await()
    const hook = contribution?.keyedHooks?.['remoteAccess']
    expect(hook?.(GUARDED)?.getSnapshot()).toBe(true)
    expect(hook?.('session/fork')?.getSnapshot()).toBe(false)
    expect(root.get('remoteAccess')?.source('session', 's1', 'session/fork').getSnapshot()).toBe(false)
    await root.fiber.dispose()
  })

  it('allows every action in its allow-all form', async () => {
    const root = new Context()
    let contribution: RootStandardSourceContribution | undefined
    root.provide('slots', { provideRoot: (value: RootStandardSourceContribution) => { contribution = value; return () => {} } } as never)
    await root.plugin(allowAllAccessPlugin).await()
    expect(contribution?.keyedHooks?.['remoteAccess']?.('session/fork')?.getSnapshot()).toBe(true)
    await root.fiber.dispose()
  })
})
