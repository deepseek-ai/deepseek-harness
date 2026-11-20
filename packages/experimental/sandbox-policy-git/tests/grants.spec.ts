/** When a Session's policy gains and loses the Git directory of the worktree it works in. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { workspaceWritableRoots } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import * as sandboxPolicyGit from '../src/index.ts'
import { agentIn, announced, cleanup, compose, extraRoots, git, repository, scratch, worktree } from './harness.ts'

afterEach(cleanup)
afterEach(() => { vi.restoreAllMocks() })

/** A promise with its resolver, for holding one filesystem read open. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

/** Hold the next `lstat` of the filesystem until `released`, then let it `settle`; `signal` is the one it was called with. */
function holdNextLstat(ctx: Context, settle: 'read' | 'fail'): { entered: Promise<void>; release: () => void; signal: () => AbortSignal | undefined } {
  const entered = gate()
  const released = gate()
  let seen: AbortSignal | undefined
  const original = ctx.fs.lstat.bind(ctx.fs)
  vi.spyOn(ctx.fs, 'lstat').mockImplementationOnce(async (...args) => {
    seen = args[2]
    entered.open()
    await released.promise
    if (settle === 'fail') throw new Error('read interrupted')
    return original(...args)
  })
  return { entered: entered.promise, release: released.open, signal: () => seen }
}

async function mounted(additionalWritableRoots: (base: string, repo: string) => string[] = () => []): Promise<{
  ctx: Context
  base: string
  repo: string
  linked: string
}> {
  const { base, repo } = await scratch()
  const linked = await worktree(repo, base, 'linked')
  const ctx = await compose(base, additionalWritableRoots(base, repo))
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

  it('keeps one registration across repeated validations and loses it when its Agent is disposed', async () => {
    const { ctx, repo, linked } = await mounted()
    const register = vi.spyOn(ctx.sandboxPolicy, 'registerWritableRoot')
    const { agent, dispose } = await announced(ctx, linked, 'validated')
    await ctx.workingDirectory.ensure(agent)
    await ctx.workingDirectory.ensure(agent)
    expect(extraRoots(ctx, agent)).toEqual([join(repo, '.git')])
    expect(register).toHaveBeenCalledTimes(1)

    await dispose()

    expect(extraRoots(ctx, agent)).toBeUndefined()
  })

  it.each(['resume', 'clear', 'compact'] as const)('grants again for an Agent announced as a %s, since no grant is stored', async (source) => {
    const { ctx, repo, linked } = await mounted()
    const { agent } = agentIn(ctx, linked, `announced-${source}`)
    const leave = ctx.agents.enter(agent)
    await ctx.agents.announce(agent, source)
    expect(extraRoots(ctx, agent)).toEqual([join(repo, '.git')])

    leave()

    expect(extraRoots(ctx, agent)).toBeUndefined()
  })

  it('gets no grant from a read that finishes after its Agent was disposed', async () => {
    const { ctx, linked } = await mounted()
    const { agent, dispose } = await announced(ctx, linked, 'disposed-during-read')
    const held = holdNextLstat(ctx, 'read')
    const validation = ctx.workingDirectory.ensure(agent)
    await held.entered

    await dispose()
    expect(extraRoots(ctx, agent)).toBeUndefined()
    held.release()

    await expect(validation).resolves.toBe(linked)
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

  it('ends the grant of the directory left in the step that commits the move, before an observer registered earlier', async () => {
    const { base, repo } = await scratch()
    const linked = await worktree(repo, base, 'linked')
    const other = await repository(base, 'other')
    const otherLinked = await worktree(other, base, 'other-linked')
    const ctx = await compose(base)
    const seen: Array<readonly string[] | undefined> = []
    ctx.on('session/event', (session, event) => {
      if (event.type === 'workspace-root/change') seen.push(ctx.sandboxPolicy.resolve({ session }).additionalWritableRoots)
    })
    await ctx.plugin(sandboxPolicyGit)
    const { agent } = await announced(ctx, linked, 'committing')

    // Neither another event nor a recorded move to the directory the grant was read for ends it.
    setSandboxMode(agent.session, 'workspace-write')
    agent.session.append('workspace-root/change', { cwd: linked })
    expect(seen).toEqual([[join(repo, '.git')]])

    await ctx.workingDirectory.set(agent, otherLinked)

    expect(seen).toEqual([[join(repo, '.git')], undefined])
    expect(extraRoots(ctx, agent)).toEqual([join(other, '.git')])
  })

  it('ends that grant before reading the entered directory for a Session that publishes no events', async () => {
    const { ctx, base, linked } = await mounted()
    const other = await repository(base, 'other')
    const otherLinked = await worktree(other, base, 'other-linked')
    const { agent } = await announced(ctx, linked, 'unpublished', true)
    const held = holdNextLstat(ctx, 'read')
    const moving = ctx.workingDirectory.set(agent, otherLinked)
    await held.entered

    expect(ctx.sandboxPolicy.resolve({ session: agent.session })).toEqual({
      mode: 'workspace-write', workspaceRoot: otherLinked, sessionId: agent.session.id,
    })
    held.release()
    await moving

    expect(extraRoots(ctx, agent)).toEqual([join(other, '.git')])
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
    const read = vi.spyOn(ctx.fs, 'readBytes').mockRejectedValue(new Error('unreadable'))

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

  it('is not granted through a pointer file above the byte cap, which is reported once', async () => {
    const { ctx, linked } = await mounted()
    await writeFile(join(linked, '.git'), 'x'.repeat(8193))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    const { agent } = await announced(ctx, linked, 'oversized')
    await ctx.workingDirectory.ensure(agent)

    expect(extraRoots(ctx, agent)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/could not read the Git layout of .* exceeds the 8192-byte limit/)
  })
})

describe('pointer files the Session can already write', () => {
  it('leaves a configured grant of the worktree\'s administration directory as narrow as configured', async () => {
    const { ctx, repo, linked } = await mounted((_base, repository) => [join(repository, '.git', 'worktrees', 'linked')])
    const register = vi.spyOn(ctx.sandboxPolicy, 'registerWritableRoot')

    const { agent } = await announced(ctx, linked, 'narrow')
    await ctx.workingDirectory.ensure(agent)

    expect(extraRoots(ctx, agent)).toEqual([join(repo, '.git', 'worktrees', 'linked')])
    expect(register).not.toHaveBeenCalled()
  })

  it('registers nothing beside a configured grant that already covers the Git directory', async () => {
    const { ctx, repo, linked } = await mounted((_base, repository) => [join(repository, '.git')])
    const register = vi.spyOn(ctx.sandboxPolicy, 'registerWritableRoot')

    const { agent } = await announced(ctx, linked, 'covered')

    expect(extraRoots(ctx, agent)).toEqual([join(repo, '.git')])
    expect(register).not.toHaveBeenCalled()
  })

  it('grants beside configured directories that are missing or lie elsewhere', async () => {
    const { ctx, base, repo, linked } = await mounted(scratchBase => [join(scratchBase, 'missing'), join(scratchBase, 'elsewhere')])
    await mkdir(join(base, 'elsewhere'))

    const { agent } = await announced(ctx, linked, 'unrelated')

    expect(extraRoots(ctx, agent)).toEqual([join(base, 'missing'), join(base, 'elsewhere'), join(repo, '.git')])
  })

  it('does not widen its own grant: a bare repository under a directory named worktrees cannot vouch for that directory\'s parent', async () => {
    const { base, repo } = await scratch()
    const bare = join(base, 'srv', 'worktrees', 'repo.git')
    await mkdir(join(base, 'srv', 'worktrees'), { recursive: true })
    await git(base, 'clone', '-q', '--bare', repo, bare)
    const linked = join(base, 'from-bare')
    await git(bare, 'worktree', 'add', '-q', '-b', 'from-bare', linked)
    const ctx = await compose(base)
    await ctx.plugin(sandboxPolicyGit)
    const { agent } = await announced(ctx, linked, 'bare')
    expect(extraRoots(ctx, agent)).toEqual([bare])

    // The pointer files below lie inside the Session's root and its grant. <base>/srv also gets a Git directory's
    // entries, so only the origin of the pointer files can refuse it.
    await writeFile(join(linked, '.git'), `gitdir: ${bare}\n`)
    await writeFile(join(bare, 'commondir'), '../..\n')
    await writeFile(join(bare, 'gitdir'), `${join(linked, '.git')}\n`)
    await writeFile(join(base, 'srv', 'HEAD'), await readFile(join(bare, 'HEAD')))
    await mkdir(join(base, 'srv', 'objects'))
    await mkdir(join(base, 'srv', 'refs'))
    await ctx.workingDirectory.ensure(agent)

    expect(extraRoots(ctx, agent)).toBeUndefined()
  })
})

describe('cancellation', () => {
  it('passes the caller\'s cancellation to the read; a cancelled read keeps the grant and warns of nothing', async () => {
    const { ctx, repo, linked } = await mounted()
    const { agent } = await announced(ctx, linked, 'cancelled')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const caller = new AbortController()
    const held = holdNextLstat(ctx, 'fail')
    const validation = ctx.workingDirectory.ensure(agent, caller.signal)
    await held.entered
    expect(held.signal()?.aborted).toBe(false)

    caller.abort(new Error('caller cancelled'))
    expect(held.signal()?.aborted).toBe(true)
    held.release()

    await expect(validation).resolves.toBe(linked)
    expect(extraRoots(ctx, agent)).toEqual([join(repo, '.git')])
    expect(warn).not.toHaveBeenCalled()
  })

  it('passes the cancellation of an Agent\'s creation to the read', async () => {
    const { ctx, linked } = await mounted()
    const { agent } = agentIn(ctx, linked, 'creation-cancelled')
    const creation = new AbortController()
    const held = holdNextLstat(ctx, 'read')
    ctx.agents.enter(agent)
    const announcing = ctx.agents.announce(agent, 'startup', creation.signal)
    await held.entered

    creation.abort(new Error('creation cancelled'))
    expect(held.signal()?.aborted).toBe(true)
    held.release()
    await announcing

    expect(extraRoots(ctx, agent)).toBeUndefined()
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

  it.each(['read', 'fail'] as const)('waits for a %s in flight when it unloads, then registers nothing and warns of nothing', async (settle) => {
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

    let unloaded = false
    const unloading = Promise.resolve(fiber.dispose()).then(() => { unloaded = true })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(held.signal()?.aborted).toBe(true)
    expect(unloaded).toBe(false)
    held.release()
    await unloading
    await registration

    expect(extraRoots(ctx, agent)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('contains a registration its unloading fiber refuses, so the validation that triggered the read still succeeds', async () => {
    const { base, repo } = await scratch()
    const linked = await worktree(repo, base, 'linked')
    const ctx = await compose(base)
    const fiber = ctx.plugin(sandboxPolicyGit)
    await fiber
    const { agent } = await announced(ctx, repo, 'unloading')
    const debug = vi.spyOn(ctx.logger, 'debug').mockImplementation(() => {})
    const held = holdNextLstat(ctx, 'read')
    const moving = ctx.workingDirectory.set(agent, linked)
    await held.entered
    // The rest of the read asks for the Session's directory twice: the policy it resolves, then its own comparison.
    // The unload starts at the comparison, after the plugin saw its own lifetime still open.
    const current = ctx.workingDirectory.get.bind(ctx.workingDirectory)
    let calls = 0
    let unloading: Promise<unknown> | undefined
    vi.spyOn(ctx.workingDirectory, 'get').mockImplementation((session) => {
      calls += 1
      if (calls === 2) unloading = Promise.resolve(fiber.dispose())
      return current(session)
    })
    held.release()

    await expect(moving).resolves.toBe(linked)
    await unloading
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^sandbox-policy-git: could not register .*inactive context/))
    expect(extraRoots(ctx, agent)).toBeUndefined()
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
