import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { FILE_REFERENCE_PROMPT } from '@deepseek-ai/dsh-file-reference'
import LocalFileReferenceService, { WorkspaceFileSearch } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  return ctx
}

async function stubAgent(
  ctx: Context,
  id = 'file-reference-agent',
  includeCwd = true,
): Promise<{ agent: Agent; dispose: () => void }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-reference-service-'))
  roots.push(root)
  await writeFile(join(root, 'README.md'), 'readme')
  const session = ctx.sessions.create(SessionId(id), { meta: includeCwd ? { cwd: root } : {} })
  const agent = {
    id: session.id,
    options: {},
    session,
    status: 'idle',
    acceptsNextStep: false,
    ctx,
    followup() {},
    steer() {},
    inject() {},
    send() {},
    updateInbox() { return 'not-found' as const },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  return { agent, dispose: ctx.agents.register(agent) }
}

describe('LocalFileReferenceService', () => {
  it('serves the addressed workspace and installs read-tool guidance for existing agents', async () => {
    const ctx = await harness()
    const { agent } = await stubAgent(ctx)
    const fiber = ctx.plugin(LocalFileReferenceService, {
      maxResults: 5,
      maxEntries: 100,
      excludedDirectories: ['.git'],
    })
    await fiber
    await expect(ctx.fileReferences.list(agent, 'README', new AbortController().signal))
      .resolves.toEqual([{ path: 'README.md', kind: 'file' }])
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain(FILE_REFERENCE_PROMPT)

    ctx.tools.register(defineContentToolFixture({
      name: 'read',
      description: 'read a file',
      parameters: {},
      execute: () => Promise.resolve([]),
    }))
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(FILE_REFERENCE_PROMPT)
    await fiber.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain(FILE_REFERENCE_PROMPT)
  })

  it('invalidates cached searches after tool results and disposes them with the agent', async () => {
    const ctx = await harness()
    const { agent, dispose } = await stubAgent(ctx)
    const invalidate = vi.spyOn(WorkspaceFileSearch.prototype, 'invalidate')
    const close = vi.spyOn(WorkspaceFileSearch.prototype, 'dispose')
    await ctx.plugin(LocalFileReferenceService)
    await ctx.fileReferences.list(agent, 'README', new AbortController().signal)

    ctx.emit('session/event', agent.session, { type: 'tool/result' } as never)
    expect(invalidate).toHaveBeenCalledOnce()
    ctx.emit('session/event', agent.session, { type: 'assistant/message' } as never)
    expect(invalidate).toHaveBeenCalledOnce()
    const orphan = ctx.sessions.create(SessionId('file-reference-orphan'))
    ctx.emit('session/event', orphan, { type: 'tool/result' } as never)
    expect(invalidate).toHaveBeenCalledOnce()

    dispose()
    expect(close).toHaveBeenCalledOnce()
    ctx.emit('agent/disposed', { agent })
  })

  it('installs guidance for agents announced after the service and validates deployment tunables', async () => {
    const ctx = await harness()
    await ctx.plugin(LocalFileReferenceService)
    const { agent } = await stubAgent(ctx)
    await expect(ctx.fileReferences.list(agent, '', new AbortController().signal))
      .resolves.toEqual([{ path: 'README.md', kind: 'file' }])

    const badResults = await harness()
    expect(() => new LocalFileReferenceService(badResults, { maxResults: 0 })).toThrow('maxResults')
    const badEntries = await harness()
    expect(() => new LocalFileReferenceService(badEntries, { maxEntries: 1.5 })).toThrow('maxEntries')
    const badExclusion = await harness()
    expect(() => new LocalFileReferenceService(badExclusion, { excludedDirectories: ['nested/name'] }))
      .toThrow('excludedDirectories')
    const fractionalResults = await harness()
    expect(() => new LocalFileReferenceService(fractionalResults, { maxResults: 1.5 })).toThrow('maxResults')
    const zeroEntries = await harness()
    expect(() => new LocalFileReferenceService(zeroEntries, { maxEntries: 0 })).toThrow('maxEntries')
    const emptyExclusion = await harness()
    expect(() => new LocalFileReferenceService(emptyExclusion, { excludedDirectories: [''] }))
      .toThrow('excludedDirectories')
    const backslashExclusion = await harness()
    expect(() => new LocalFileReferenceService(backslashExclusion, { excludedDirectories: ['nested\\name'] }))
      .toThrow('excludedDirectories')
  })

  it('deduplicates lifecycle announcements and falls back to the process cwd', async () => {
    const ctx = await harness()
    const fiber = ctx.plugin(LocalFileReferenceService)
    await fiber
    const { agent } = await stubAgent(ctx, 'cwd-fallback', false)
    ctx.emit('agent/created', { agent })
    const list = vi.spyOn(WorkspaceFileSearch.prototype, 'list').mockResolvedValue([])
    await expect(ctx.fileReferences.list(agent, '', new AbortController().signal)).resolves.toEqual([])
    await expect(ctx.fileReferences.list(agent, 'src', new AbortController().signal)).resolves.toEqual([])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('logs rejected prompt cleanup without failing service teardown', async () => {
    const ctx = await harness()
    const fiber = ctx.plugin(LocalFileReferenceService)
    await fiber
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const inject = vi.spyOn(ctx, 'inject')
      .mockReturnValueOnce({ dispose: () => Promise.reject(new Error('error cleanup')) } as never)
      // Deliberately proves cleanup tolerates JavaScript callers rejecting non-Error values.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors
      .mockReturnValueOnce({ dispose: () => Promise.reject('string cleanup') } as never)
    const first = await stubAgent(ctx, 'cleanup-one')
    const second = await stubAgent(ctx, 'cleanup-two')
    expect(inject).toHaveBeenCalledTimes(2)
    first.dispose()
    second.dispose()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('file-reference-local: prompt cleanup failed: error cleanup')
      expect(warn).toHaveBeenCalledWith('file-reference-local: prompt cleanup failed: string cleanup')
    })
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })
})
