/** When a Session's policy gains and loses the Git directory of the worktree it works in. */
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { workspaceWritableRoots } from '@deepseek-ai/dsh-sandbox'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import * as sandboxPolicyGit from '../src/index.ts'
import { agentIn, announced, cleanup, compose, extraRoots, repository, scratch, worktree } from './harness.ts'

afterEach(cleanup)

/** A promise with its resolver, for holding one filesystem read open. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

/** Hold the next `lstat` of the filesystem until `released`, then let it `settle`. */
function holdNextLstat(ctx: Context, settle: 'read' | 'fail'): { entered: Promise<void>; release: () => void } {
  const entered = gate()
  const released = gate()
  const original = ctx.fs.lstat.bind(ctx.fs)
  vi.spyOn(ctx.fs, 'lstat').mockImplementationOnce(async (...args) => {
    entered.open()
    await released.promise
    if (settle === 'fail') throw new Error('read interrupted')
    return original(...args)
  })
  return { entered: entered.promise, release: released.open }
}

async function mounted(): Promise<{ ctx: Context; base: string; repo: string; linked: string }> {
  const { base, repo } = await scratch()
  const linked = await worktree(repo, base, 'linked')
  const ctx = await compose(base)
  await ctx.plugin(sandboxPolicyGit)
  return { ctx, base, repo, linked }
}

describe('a Session created in a linked worktree', () => {
  it('may write the repository Git directory, which the model context names; other Sessions and agentless calls may not', async () => {
    const { ctx, repo, linked } = await mounted()
    const { agent } = await announced(ctx, linked, 'in-worktree')
    const main = await announced(ctx, repo, 'in-main')

    expect(ctx.sandboxPolicy.resolve({ session: agent.session })).toEqual({
      mode: 'workspace-write', workspaceRoot: linked, additionalWritableRoots: [join(repo, '.git')], sessionId: agent.session.id,
    })
    expect(extraRoots(ctx, main.agent)).toBeUndefined()
    expect(ctx.sandboxPolicy.resolve().additionalWritableRoots).toBeUndefined()
    const context = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent, scope: agent }))
    expect(context).toContain(`Additional writable directories: ${JSON.stringify([join(repo, '.git')])}.`)
  })

  it('keeps the grant across repeated validations and loses it when its Agent is disposed', async () => {
    const { ctx, repo, linked } = await mounted()
    const { agent, dispose } = await announced(ctx, linked, 'validated')
    await ctx.workingDirectory.ensure(agent)
    await ctx.workingDirectory.ensure(agent)
    expect(extraRoots(ctx, agent)).toEqual([join(repo, '.git')])

    await dispose()

    expect(extraRoots(ctx, agent)).toBeUndefined()
  })
})

describe('a Host move of the Session directory', () => {
  it('grants on entering a worktree, replaces the grant in a worktree of another repository, and revokes on leaving', async () => {
    const { ctx, base, repo, linked } = await mounted()
    const other = await repository(base, 'other')
    const otherLinked = await worktree(other, base, 'other-linked')
    const { agent } = await announced(ctx, repo, 'moving')
    expect(extraRoots(ctx, agent)).toBeUndefined()

    await ctx.workingDirectory.set(agent, linked)
    expect(extraRoots(ctx, agent)).toEqual([join(repo, '.git')])
    await ctx.workingDirectory.set(agent, otherLinked)
    expect(extraRoots(ctx, agent)).toEqual([join(other, '.git')])
    await ctx.workingDirectory.set(agent, repo)
    expect(extraRoots(ctx, agent)).toBeUndefined()
  })

  it('discards a read of the directory the Session has left meanwhile', async () => {
    const { ctx, repo, linked } = await mounted()
    const { agent, register } = agentIn(ctx, linked, 'overtaken')
    const held = holdNextLstat(ctx, 'read')
    const registration = register()
    await held.entered

    await ctx.workingDirectory.set(agent, repo)
    held.release()
    await registration

    expect(extraRoots(ctx, agent)).toBeUndefined()
  })
})

describe('a Git directory that changes under a Session', () => {
  it('is revoked at the next validation once it disappeared, and granted again once it is back', async () => {
    const { ctx, repo, linked } = await mounted()
    const { agent } = await announced(ctx, linked, 'vanishing')
    await rename(join(repo, '.git'), join(repo, '.git-away'))
    const roots = (): string[] => workspaceWritableRoots(ctx.sandboxPolicy.resolve({ session: agent.session }))
    // Until the next validation the stale grant fails every confined call of the Session.
    expect(roots).toThrow(/Invalid additional writable directory/)

    await ctx.workingDirectory.ensure(agent)
    expect(extraRoots(ctx, agent)).toBeUndefined()
    expect(roots()).toEqual([linked])

    await rename(join(repo, '.git-away'), join(repo, '.git'))
    await ctx.workingDirectory.ensure(agent)
    expect(extraRoots(ctx, agent)).toEqual([join(repo, '.git')])
  })

  it('is revoked while its layout cannot be read, with one warning per directory, and the move still succeeds', async () => {
    const { ctx, base, repo, linked } = await mounted()
    const second = await worktree(repo, base, 'second')
    const { agent } = await announced(ctx, linked, 'unreadable')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const read = vi.spyOn(ctx.fs, 'readText').mockRejectedValue(new Error('unreadable'))

    await expect(ctx.workingDirectory.ensure(agent)).resolves.toBe(linked)
    await expect(ctx.workingDirectory.ensure(agent)).resolves.toBe(linked)
    expect(extraRoots(ctx, agent)).toBeUndefined()
    expect(warn.mock.calls).toEqual([[
      `sandbox-policy-git: could not read the Git layout of ${JSON.stringify(linked)}; its Git directory is not writable: Error: unreadable`,
    ]])
    await expect(ctx.workingDirectory.set(agent, second)).resolves.toBe(second)
    expect(warn).toHaveBeenCalledTimes(2)

    read.mockRestore()
    await ctx.workingDirectory.ensure(agent)
    expect(extraRoots(ctx, agent)).toEqual([join(repo, '.git')])
  })
})

describe('plugin lifetime', () => {
  it('removes every grant when the plugin is unloaded', async () => {
    const { base, repo } = await scratch()
    const linked = await worktree(repo, base, 'linked')
    const ctx = await compose(base)
    const fiber = ctx.plugin(sandboxPolicyGit)
    await fiber
    const { agent } = await announced(ctx, linked, 'unloaded')
    expect(extraRoots(ctx, agent)).toEqual([join(repo, '.git')])

    await fiber.dispose()

    expect(extraRoots(ctx, agent)).toBeUndefined()
    await expect(ctx.workingDirectory.ensure(agent)).resolves.toBe(linked)
    expect(extraRoots(ctx, agent)).toBeUndefined()
  })

  it.each(['read', 'fail'] as const)('registers nothing and warns of nothing for a %s that settles after the unload', async (settle) => {
    const { base, repo } = await scratch()
    const linked = await worktree(repo, base, 'linked')
    const ctx = await compose(base)
    const fiber = ctx.plugin(sandboxPolicyGit)
    await fiber
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const { agent, register } = agentIn(ctx, linked, `late-${settle}`)
    const held = holdNextLstat(ctx, settle)
    const registration = register()
    await held.entered

    await fiber.dispose()
    held.release()
    await registration

    expect(extraRoots(ctx, agent)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('registers nothing on Windows, whose process confinement ignores additional writable directories', async () => {
    const { base, repo } = await scratch()
    const linked = await worktree(repo, base, 'linked')
    const ctx = await compose(base)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      await ctx.plugin(sandboxPolicyGit)
    } finally {
      platform.mockRestore()
    }
    const { agent } = await announced(ctx, linked, 'windows')
    await ctx.workingDirectory.ensure(agent)

    expect(extraRoots(ctx, agent)).toBeUndefined()
  })
})
