/**
 * The plugin body: one `file` provider registered into `ctx.resources` for the
 * fiber's lifetime, reading through `ctx.remote` in the Session each address names.
 */
import { Context } from '@deepseek-ai/cordis'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { FakeRemote, settle } from './fake-remote.client.ts'

describe('workspace-files client apply', () => {
  it('registers the file provider over ctx.remote, and unregisters it with the fiber', async () => {
    const ctx = new Context()
    const remote = new FakeRemote()
    const controller = new AbortController()
    const pulls: Array<Promise<unknown>> = []
    ctx.provide('remote', remote as never)
    ctx.provide('remote.workspaceFiles', remote.workspaceFiles as never)
    const registered: Array<ResourceProvider<'file'>> = []
    let released = 0
    ctx.provide('resources', {
      register: (provider: ResourceProvider<'file'>) => {
        registered.push(provider)
        return () => {
          released++
          controller.abort()
          for (const request of remote.stats) {
            request.resolve({ ok: true, value: { absolutePath: '/host/late-stat', version: 'v0' } })
          }
        }
      },
    } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    onTestFinished(async () => {
      await fiber.dispose()
      await Promise.all(pulls)
    })
    await fiber.await()

    expect(registered.map(provider => provider.protocol)).toEqual(['file'])
    const signal = controller.signal
    // A session address reaches the Host with its relative or absolute path.
    pulls.push(registered[0]!.open(sessionFileAddress('s1', 'a.txt'), { signal })[Symbol.asyncIterator]().next())
    pulls.push(registered[0]!.open(sessionFileAddress('s1', '/etc/hosts'), { signal })[Symbol.asyncIterator]().next())
    await settle()
    expect(remote.stats.map(pending => [pending.sessionId, pending.path])).toEqual([['s1', 'a.txt'], ['s1', '/etc/hosts']])
    expect(remote.opened).toHaveLength(1)

    await fiber.dispose()
    await Promise.all(pulls)
    expect(released).toBe(1)
    expect(remote.opened[0]!.source.aborted).toBe(true)
  })
})
