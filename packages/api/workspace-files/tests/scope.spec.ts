import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceFiles from '../src/index.ts'

const CAPS = {
  maxBytes: 1024,
  maxFileBytes: 1024,
  maxLines: 100,
  maxEntries: 100,
}

function header(id: SessionId, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    origin: 'subagent',
    ...cwd === undefined ? {} : { cwd },
  }
}

describe('Workspace Files Session scope lookup', () => {
  it('prefers the recorded workspace root of a live or stored Session over its header directory', async () => {
    const liveId = SessionId('live-relocated')
    const coldId = SessionId('cold-relocated')
    const plainId = SessionId('cold-plain')
    const liveRoot = resolve('live-workspace')
    const liveWorktree = resolve('live-workspace', '.agents', 'worktrees', 'topic')
    const coldRoot = resolve('cold-workspace')
    const coldWorktree = resolve('elsewhere', 'cold-topic')
    const stat = vi.fn(async (id: SessionId) => {
      if (id === coldId) return { header: header(coldId, coldRoot) }
      if (id === plainId) return { header: header(plainId, coldRoot) }
      return undefined
    })
    const cachedSnapshot = vi.fn((meta: SessionHeader) =>
      meta.id === coldId ? { asOfSeq: 4, values: { workspaceRoot: coldWorktree } } : undefined)
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', { workspaceRoot: resolve('fallback-workspace') } as never)
    ctx.provide('sessionPersistence', { stat } as never)
    ctx.provide('sessionProjectionCache', { cachedSnapshot } as never)
    ctx.provide('workingDirectory', {
      anchorsOf: () => [liveRoot, liveWorktree],
      rootOf: () => liveWorktree,
    } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)
    try {
      ctx.sessions.create(liveId, { meta: { cwd: liveRoot, origin: 'subagent' } })
      await expect(ctx.workspaceFiles.scopeOf(liveId)).resolves.toEqual({ sessionId: liveId, workspaceRoot: liveWorktree })
      await expect(ctx.workspaceFiles.scopeOf(coldId)).resolves.toEqual({ sessionId: coldId, workspaceRoot: coldWorktree })
      await expect(ctx.workspaceFiles.scopeOf(plainId)).resolves.toEqual({ sessionId: plainId, workspaceRoot: coldRoot })
      expect(cachedSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: coldId }), ['workspaceRoot'])
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')
      await expect(lookup.resolve(liveId)).resolves.toEqual({ sessionId: liveId, workspaceRoot: liveWorktree })
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })

  it('uses live or stored headers without an Agent and leaves with its plugin', async () => {
    const liveId = SessionId('live-subagent')
    const coldId = SessionId('cold-subagent')
    const fallbackId = SessionId('cold-without-cwd')
    const liveFallbackId = SessionId('live-without-cwd')
    const missingId = SessionId('missing')
    const liveRoot = resolve('live-workspace')
    const coldRoot = resolve('cold-workspace')
    const fallbackRoot = resolve('fallback-workspace')
    const stat = vi.fn(async (id: SessionId) => {
      if (id === coldId) return { header: header(coldId, coldRoot) }
      if (id === fallbackId) return { header: header(fallbackId) }
      return undefined
    })
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', { workspaceRoot: fallbackRoot } as never)
    ctx.provide('sessionPersistence', { stat } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)

    try {
      ctx.sessions.create(liveId, { meta: { cwd: liveRoot, origin: 'subagent' } })
      ctx.sessions.create(liveFallbackId, { meta: { origin: 'subagent' } })
      expect(ctx.get('agents')).toBeUndefined()
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      expect(lookup).toMatchObject({
        parameter: 'workspaceFileScope',
        wire: 'workspaceFileScopeId',
        // A method taking a scope reads the scope's Session as its access-control resource.
        resource: 'session',
        hostTypeSymbol: '@deepseek-ai/dsh-api-workspace-files#WorkspaceFileScope',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      })
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')

      await expect(lookup.resolve(liveId)).resolves.toEqual({ sessionId: liveId, workspaceRoot: liveRoot })
      await expect(lookup.resolve(liveFallbackId)).resolves.toEqual({ sessionId: liveFallbackId, workspaceRoot: fallbackRoot })
      expect(stat).not.toHaveBeenCalled()
      const signal = new AbortController().signal
      await expect(ctx.workspaceFiles.scopeOf(coldId, signal)).resolves.toEqual({ sessionId: coldId, workspaceRoot: coldRoot })
      expect(stat).toHaveBeenLastCalledWith(coldId, { signal })
      await expect(lookup.resolve(coldId)).resolves.toEqual({ sessionId: coldId, workspaceRoot: coldRoot })
      await expect(lookup.resolve(fallbackId)).resolves.toEqual({ sessionId: fallbackId, workspaceRoot: fallbackRoot })
      await expect(lookup.resolve(missingId)).resolves.toBeUndefined()
      expect(stat.mock.calls.map(([id]) => id)).toEqual([coldId, coldId, fallbackId, missingId])

      await workspaceFiles.dispose()
      expect(ctx.typert.lookups.get('workspaceFileScope')).toBeUndefined()
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })
})
