import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory, { type Config as WorkingDirectoryConfig } from '@deepseek-ai/dsh-working-directory'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as WorkingDirectoryTool from '@deepseek-ai/dsh-tool-working-directory'

async function fixture(config?: (root: string) => WorkingDirectoryConfig) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-working-directory-')))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    const directoryFiber = ctx.plugin(WorkingDirectory, config?.(root) ?? {})
    await directoryFiber
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('directory-owner'), {}, { cwd: root })
    return {
      ctx, root, agent, harness, directoryFiber,
      async [Symbol.asyncDispose]() {
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

describe('Session working directories', () => {
  it('keeps origin metadata and other Sessions independent while logging the changed directory', async () => {
    await using f = await fixture()
    const child = join(f.root, 'child')
    await mkdir(child)
    const sibling = await f.harness.create(SessionId('sibling'), {}, { cwd: f.root })
    await expect(f.ctx.workingDirectory.set(f.agent, 'child')).resolves.toBe(child)
    expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(child)
    expect(f.ctx.workingDirectory.get(sibling.session)).toBe(f.root)
    expect(f.agent.session.header.cwd).toBe(f.root)
    expect(f.agent.session.snapshotEvents()).toContainEqual(expect.objectContaining({
      type: 'working-directory/change', data: { cwd: child },
    }))
    const messages = f.harness.claim(f.agent, 'next-step', 1)
    expect(messages).toEqual([expect.objectContaining({
      role: 'user',
      content: [{ type: 'text', text: `The working directory changed from ${JSON.stringify(f.root)} to ${JSON.stringify(child)}.` }],
    })])
  })

  it('restores directory state from the log', async () => {
    await using f = await fixture()
    const child = join(f.root, 'child')
    await mkdir(child)
    await f.ctx.workingDirectory.set(f.agent, child)
    const restored = f.ctx.sessions.create(SessionId('restored'), {
      meta: { cwd: f.root }, seed: f.agent.session.snapshotEvents(),
    })
    expect(f.ctx.workingDirectory.get(restored)).toBe(child)
  })

  it('exposes the current directory in wire observations after replay without an Agent', async () => {
    await using f = await fixture()
    const directory = join(f.root, 'moved')
    await mkdir(directory)
    const withoutOrigin = f.ctx.sessions.create(SessionId('wire-without-origin'))
    expect(f.ctx.sessionProjections.snapshot(withoutOrigin).values.workingDirectory).toBeNull()
    expect(f.ctx.sessionProjections.snapshot(f.agent.session).values.workingDirectory).toBe(f.root)
    await f.ctx.workingDirectory.set(f.agent, directory)
    const restored = f.ctx.sessions.create(SessionId('wire-restored'), {
      meta: { cwd: f.root }, seed: f.agent.session.snapshotEvents(),
    })
    expect(f.ctx.agents.get(restored.id)).toBeUndefined()
    expect(f.ctx.sessionProjections.snapshot(restored).values.workingDirectory).toBe(directory)
    expect(restored.header.cwd).toBe(f.root)
  })

  it('serializes concurrent relative changes and recovers after a rejected change', async () => {
    await using f = await fixture()
    await mkdir(join(f.root, 'a', 'b'), { recursive: true })
    await expect(Promise.all([
      f.ctx.workingDirectory.set(f.agent, 'a'),
      f.ctx.workingDirectory.set(f.agent, 'b'),
    ])).resolves.toEqual([join(f.root, 'a'), join(f.root, 'a', 'b')])
    await expect(f.ctx.workingDirectory.set(f.agent, 'missing')).rejects.toThrow('directory does not exist')
    await expect(f.ctx.workingDirectory.set(f.agent, '..')).resolves.toBe(join(f.root, 'a'))
  })

  it('returns to the original project when the selected directory disappears and injects the recovery', async () => {
    await using f = await fixture()
    const child = join(f.root, 'temporary')
    await mkdir(child)
    await f.ctx.workingDirectory.set(f.agent, child)
    f.harness.claim(f.agent, 'next-step', 1)
    await rm(child, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.root)
    expect(f.harness.claim(f.agent, 'next-step', 1)).toEqual([expect.objectContaining({
      content: [{ type: 'text', text: `The working directory ${JSON.stringify(child)} is unavailable. The working directory is now ${JSON.stringify(f.root)}.` }],
    })])
  })

  it('reports a missing original project and permits an explicit directory change to recover', async () => {
    await using f = await fixture()
    const origin = join(f.root, 'original')
    await mkdir(origin)
    const agent = await f.harness.create(SessionId('removed-origin'), {}, { cwd: origin })
    await rm(origin, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(agent)).rejects.toThrow('directory does not exist')
    await expect(f.ctx.workingDirectory.set(agent, f.root)).resolves.toBe(f.root)
  })

  it('rejects files, empty paths, and cancelled changes without changing state', async () => {
    await using f = await fixture()
    await writeFile(join(f.root, 'file'), '')
    await expect(f.ctx.workingDirectory.set(f.agent, 'file')).rejects.toThrow('directory does not exist')
    await expect(f.ctx.workingDirectory.set(f.agent, '')).rejects.toThrow('cd must not be empty')
    const controller = new AbortController()
    controller.abort(new Error('cancelled directory change'))
    await expect(f.ctx.workingDirectory.set(f.agent, f.root, controller.signal)).rejects.toThrow('cancelled directory change')
    expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(f.root)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
  })

  it('keeps unchanged reads and changes free of transition notices', async () => {
    await using f = await fixture()
    await f.ctx.workingDirectory.ensure(f.agent)
    await f.ctx.workingDirectory.set(f.agent, f.root)
    expect(f.harness.claim(f.agent, 'next-step', 1)).toEqual([])
  })

  it('provides required user context instead of a system-prompt directory, including recovery during assembly', async () => {
    await using f = await fixture()
    const child = join(f.root, 'temporary')
    await mkdir(child)
    await f.ctx.workingDirectory.set(f.agent, child)
    await rm(child, { recursive: true })
    const assembly = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
    expect(renderContextSnapshot(assembly)).toContain(`Current working directory: ${JSON.stringify(f.root)}.`)
    expect(renderPrompt(assembly)).not.toContain(f.root)
    expect(renderContextSnapshot(await f.ctx.systemPrompt.assemble())).toBe('')
  })

  it('uses and records the configured launch fallback for a Session without origin metadata', async () => {
    await using f = await fixture()
    const agent = await f.harness.create(SessionId('without-origin'))
    const fallback = f.ctx.workingDirectory.defaultDirectory
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(fallback)
    expect(agent.session.snapshotEvents()).toContainEqual(expect.objectContaining({
      type: 'working-directory/change', data: { cwd: fallback },
    }))
  })

  it('rejects a relative deployment default before accepting Sessions', async () => {
    await expect(fixture(() => ({ defaultDirectory: 'relative/project' }))).rejects.toThrow('defaultDirectory must be absolute')
  })

  it('recovers a Session without origin metadata to its configured default', async () => {
    await using f = await fixture(root => ({ defaultDirectory: root }))
    const agent = await f.harness.create(SessionId('fallback-recovery'))
    const temporary = join(f.root, 'temporary')
    await mkdir(temporary)
    await f.ctx.workingDirectory.set(agent, temporary)
    f.harness.claim(agent, 'next-step', 1)
    await rm(temporary, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(f.root)
    expect(agent.session.header.cwd).toBeUndefined()
    expect(f.harness.claim(agent, 'next-step', 1)).toEqual([expect.objectContaining({
      content: [{ type: 'text', text: `The working directory ${JSON.stringify(temporary)} is unavailable. The working directory is now ${JSON.stringify(f.root)}.` }],
    })])
  })

  it.each(['remove', 'replace'] as const)('retains required current-directory context after an assembly transform can %s it', async (change) => {
    await using f = await fixture()
    f.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      return {
        ...assembled,
        contexts: change === 'remove' ? [] : [{ name: 'working-directory:current', text: 'outdated directory' }],
      }
    })
    const assembled = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
    expect(assembled.contexts).toEqual([{
      name: 'working-directory:current', text: `Current working directory: ${JSON.stringify(f.root)}.`, interpolate: false,
    }])
    expect(renderPrompt(assembled)).not.toContain(f.root)
  })

  it.each([false, true])('renders variable-looking directory names literally after context removal is %s', async (removeContext) => {
    await using f = await fixture()
    const directory = join(f.root, '{{project}}-{{unknown}}-{{malformed-name}}')
    await mkdir(directory)
    f.ctx.systemPrompt.variable('project', () => 'wrong-directory')
    if (removeContext) {
      f.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(), contexts: [] }))
    }
    await f.ctx.workingDirectory.set(f.agent, directory)
    const assembly = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
    expect(renderContextSnapshot(assembly)).toContain(`Current working directory: ${JSON.stringify(directory)}.`)
    expect(renderContextSnapshot(assembly)).not.toContain('wrong-directory')
  })

  it('does not commit a cancelled filesystem lookup and lets the next queued change proceed', async () => {
    await using f = await fixture()
    await mkdir(join(f.root, 'first'))
    await mkdir(join(f.root, 'second'))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stat = f.ctx.fs.stat.bind(f.ctx.fs)
    const probe = vi.spyOn(f.ctx.fs, 'stat').mockImplementationOnce(async (target) => {
      const info = await stat(target)
      entered.resolve(undefined)
      await release.promise
      return info
    })
    const controller = new AbortController()
    const cancelled = f.ctx.workingDirectory.set(f.agent, 'first', controller.signal)
    const rejection = expect(cancelled).rejects.toThrow('cancelled while checking directory')
    try {
      await entered.promise
      const queued = f.ctx.workingDirectory.set(f.agent, 'second')
      controller.abort(new Error('cancelled while checking directory'))
      release.resolve(undefined)
      await rejection
      await expect(queued).resolves.toBe(join(f.root, 'second'))
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
        .toEqual([expect.objectContaining({ data: { cwd: join(f.root, 'second') } })])
      expect(f.harness.claim(f.agent, 'next-step', 1)).toHaveLength(1)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([cancelled, rejection])
      probe.mockRestore()
    }
  })

  it.each(['ensure', 'set'] as const)('aborts and drains pending %s before disposal completes', async (operation) => {
    await using f = await fixture()
    const directories = f.ctx.workingDirectory
    const entered = Promise.withResolvers<AbortSignal>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stat = f.ctx.fs.stat.bind(f.ctx.fs)
    const probe = vi.spyOn(f.ctx.fs, 'stat').mockImplementationOnce(async (target, signal) => {
      const info = await stat(target)
      if (signal === undefined) throw new Error('directory probe requires a cancellation signal')
      signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      entered.resolve(signal)
      await release.promise
      return info
    })
    const pending = operation === 'ensure'
      ? directories.ensure(f.agent)
      : directories.set(f.agent, f.root)
    const rejection = expect(pending).rejects.toThrow('working-directory service disposed')
    let disposal: Promise<void> | undefined
    try {
      const signal = await entered.promise
      let disposed = false
      disposal = f.directoryFiber.dispose().then(() => { disposed = true })
      await aborted.promise
      // Flush disposal's promise reactions while the provider remains parked.
      await setImmediate()
      expect(signal.aborted).toBe(true)
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await rejection
      await disposal
      expect(disposed).toBe(true)
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
      expect(f.harness.claim(f.agent, 'next-step', 1)).toEqual([])
      await expect(directories.ensure(f.agent)).rejects.toThrow('working-directory service disposed')
      expect(probe).toHaveBeenCalledOnce()
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([pending, rejection, disposal])
      probe.mockRestore()
    }
  })

  it('refuses an Agent disposed during directory inspection without publishing a change', async () => {
    await using f = await fixture()
    await mkdir(join(f.root, 'child'))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stat = f.ctx.fs.stat.bind(f.ctx.fs)
    const probe = vi.spyOn(f.ctx.fs, 'stat').mockImplementationOnce(async (target) => {
      const info = await stat(target)
      entered.resolve(undefined)
      await release.promise
      return info
    })
    const pending = f.ctx.workingDirectory.set(f.agent, 'child')
    const rejection = expect(pending).rejects.toThrow('inactive context')
    try {
      await entered.promise
      await f.agent.ctx.fiber.dispose()
      release.resolve(undefined)
      await rejection
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
      await expect(f.ctx.workingDirectory.ensure(f.agent)).rejects.toThrow('inactive context')
      expect(probe).toHaveBeenCalledOnce()
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([pending, rejection])
      probe.mockRestore()
    }
  })

  it('returns committed state and warns when the notice cannot be queued', async () => {
    await using f = await fixture()
    const child = join(f.root, 'child')
    await mkdir(child)
    const inject = vi.spyOn(f.agent, 'inject').mockImplementation(() => { throw new Error('inbox unavailable') })
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    try {
      await expect(f.ctx.workingDirectory.set(f.agent, child)).resolves.toBe(child)
      expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(child)
      expect(warn).toHaveBeenCalledWith(`working-directory: committed ${JSON.stringify(child)}, but could not queue its notice: Error: inbox unavailable`)
      const restored = await f.ctx.agents.create({
        sessionId: SessionId('notice-failure-restored'),
        seed: f.agent.session.snapshotEvents(),
        meta: { cwd: f.root },
      })
      try {
        expect(renderContextSnapshot(await f.ctx.systemPrompt.assemble({ agent: restored.agent, scope: restored.agent })))
          .toContain(`Current working directory: ${JSON.stringify(child)}.`)
      } finally {
        await restored.dispose()
      }
    } finally {
      inject.mockRestore()
      warn.mockRestore()
    }
  })

  it('exposes reading and changing through the same model tool and unregisters it on disposal', async () => {
    await using f = await fixture()
    await mkdir(join(f.root, 'child'))
    const fiber = f.ctx.plugin(WorkingDirectoryTool)
    await fiber
    const execute = (arguments_: { cd?: string }, withAgent = true) => f.ctx.tools.execute({
      name: 'working_directory', callId: ToolCallId('directory-call'), arguments: arguments_,
      signal: new AbortController().signal, ...withAgent ? { agent: f.agent } : {},
    })
    expect(await execute({})).toMatchObject({ value: { cwd: f.root }, isError: false })
    expect(await execute({ cd: 'child' })).toMatchObject({ value: { cwd: join(f.root, 'child') }, isError: false })
    expect(await execute({}, false)).toMatchObject({ isError: true })
    await fiber.dispose()
    expect(f.ctx.tools.schemas().some(tool => tool.name === 'working_directory')).toBe(false)
  })
})
