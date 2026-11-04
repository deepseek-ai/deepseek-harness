/** Workspace roots: anchors registered by relocation, the root the cursor selects, and the context both reach the model through. */
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory, { within } from '@deepseek-ai/dsh-working-directory'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'

async function fixture() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-root-')))
  const root = join(scratch, 'repo')
  const worktree = join(scratch, 'elsewhere', 'wt')
  const outside = join(scratch, 'outside')
  await mkdir(join(root, 'packages', 'foo'), { recursive: true })
  await mkdir(join(root, '.agents', 'worktrees', 'nested', 'src'), { recursive: true })
  await mkdir(join(worktree, 'src'), { recursive: true })
  await mkdir(outside)
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectory, {})
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('root-owner'), {}, { cwd: root })
    return {
      ctx, root, worktree, outside, nested: join(root, '.agents', 'worktrees', 'nested'), agent, harness,
      notices: () => harness.claim(agent, 'next-step', 1).map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')),
      context: async () => renderContextSnapshot(await ctx.systemPrompt.assemble({ agent, scope: agent })),
      async [Symbol.asyncDispose]() {
        await ctx.fiber.dispose()
        await rm(scratch, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(scratch, { recursive: true, force: true })
    throw error
  }
}

describe('Session workspace roots', () => {
  it('starts with the original project as the only anchor and root', async () => {
    await using f = await fixture()
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.root)
    expect(f.ctx.workingDirectory.anchorsOf(f.agent.session)).toEqual([f.root])
    expect(f.ctx.sessionProjections.snapshot(f.agent.session).values.workspaceRoot).toBe(f.root)
    expect(await f.context()).toContain(`Current working directory: ${JSON.stringify(f.root)}.`)
    expect(await f.context()).not.toContain('Workspace root:')
  })

  it('moves only the cursor inside the root and reports both to the model', async () => {
    await using f = await fixture()
    const foo = join(f.root, 'packages', 'foo')
    await f.ctx.workingDirectory.set(f.agent, 'packages/foo')
    expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(foo)
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.root)
    expect(f.notices()).toEqual([`The working directory changed from ${JSON.stringify(f.root)} to ${JSON.stringify(foo)}.`])
    expect(await f.context()).toContain(`Current working directory: ${JSON.stringify(foo)}.\nWorkspace root: ${JSON.stringify(f.root)}.`)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
      .toEqual([expect.objectContaining({ data: { cwd: foo } })])
  })

  it('leaves the root behind when the cursor goes outside every anchor', async () => {
    await using f = await fixture()
    await f.ctx.workingDirectory.set(f.agent, f.outside)
    expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(f.outside)
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.root)
    expect(f.notices()).toEqual([`The working directory changed from ${JSON.stringify(f.root)} to ${JSON.stringify(f.outside)}.`])
    expect(await f.context()).toContain(`Workspace root: ${JSON.stringify(f.root)}.`)
  })

  it('relocates into another checkout with one event, then returns to the original project through an ordinary change', async () => {
    await using f = await fixture()
    await expect(f.ctx.workingDirectory.relocate(f.agent, f.worktree)).resolves.toEqual({ root: f.worktree, cwd: f.worktree })
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.worktree)
    expect(f.ctx.workingDirectory.anchorsOf(f.agent.session)).toEqual([f.root, f.worktree])
    expect(f.ctx.sessionProjections.snapshot(f.agent.session).values.workspaceRoot).toBe(f.worktree)
    expect(f.notices()).toEqual([
      `The working directory changed from ${JSON.stringify(f.root)} to ${JSON.stringify(f.worktree)}. ${JSON.stringify(f.worktree)} is now the workspace root.`,
    ])
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
      .toEqual([expect.objectContaining({ data: { cwd: f.worktree, anchor: f.worktree } })])
    expect(await f.context()).not.toContain('Workspace root:')

    await f.ctx.workingDirectory.set(f.agent, 'src')
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.worktree)
    expect(f.notices()).toEqual([`The working directory changed from ${JSON.stringify(f.worktree)} to ${JSON.stringify(join(f.worktree, 'src'))}.`])

    await f.ctx.workingDirectory.set(f.agent, f.root)
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.root)
    expect(f.ctx.workingDirectory.anchorsOf(f.agent.session)).toEqual([f.root, f.worktree])
    expect(f.notices()).toEqual([
      `The working directory changed from ${JSON.stringify(join(f.worktree, 'src'))} to ${JSON.stringify(f.root)}. ${JSON.stringify(f.root)} is now the workspace root.`,
    ])
  })

  it('selects the longest anchor when checkouts nest and enters a directory inside the new root', async () => {
    await using f = await fixture()
    const src = join(f.nested, 'src')
    await expect(f.ctx.workingDirectory.relocate(f.agent, '.agents/worktrees/nested', { cwd: 'src' })).resolves.toEqual({ root: f.nested, cwd: src })
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.nested)
    expect(f.notices()).toEqual([
      `The working directory changed from ${JSON.stringify(f.root)} to ${JSON.stringify(src)}. ${JSON.stringify(f.nested)} is now the workspace root.`,
    ])
    expect(await f.context()).toContain(`Current working directory: ${JSON.stringify(src)}.\nWorkspace root: ${JSON.stringify(f.nested)}.`)
    await f.ctx.workingDirectory.set(f.agent, join(f.root, 'packages'))
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.root)
  })

  it('registers an anchor without moving the cursor and ignores a repeated anchor', async () => {
    await using f = await fixture()
    const src = join(f.nested, 'src')
    await f.ctx.workingDirectory.set(f.agent, src)
    f.notices()
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.root)
    await expect(f.ctx.workingDirectory.relocate(f.agent, f.nested, { cwd: src })).resolves.toEqual({ root: f.nested, cwd: src })
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.nested)
    expect(f.notices()).toEqual([`${JSON.stringify(f.nested)} is now the workspace root.`])
    await expect(f.ctx.workingDirectory.relocate(f.agent, f.nested, { cwd: src })).resolves.toEqual({ root: f.nested, cwd: src })
    expect(f.notices()).toEqual([])
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toHaveLength(2)
  })

  it('records an enclosing anchor that changes neither the cursor nor the root without a notice', async () => {
    await using f = await fixture()
    const packages = join(f.root, 'packages')
    const agent = await f.harness.create(SessionId('enclosed-origin'), {}, { cwd: packages })
    // The enclosing anchor is registered, but the original project stays the longest anchor containing the cursor.
    await expect(f.ctx.workingDirectory.relocate(agent, f.root, { cwd: packages })).resolves.toEqual({ root: packages, cwd: packages })
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(packages)
    expect(f.ctx.workingDirectory.anchorsOf(agent.session)).toEqual([packages, f.root])
    expect(f.harness.claim(agent, 'next-step', 1)).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
      .toEqual([expect.objectContaining({ data: { cwd: packages, anchor: f.root } })])
    await f.ctx.workingDirectory.set(agent, f.root)
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(f.root)
  })

  it('rejects a relocation whose directory lies outside the root, a missing root, and empty paths without committing', async () => {
    await using f = await fixture()
    await expect(f.ctx.workingDirectory.relocate(f.agent, f.worktree, { cwd: f.outside })).rejects.toThrow('lies outside the workspace root')
    await expect(f.ctx.workingDirectory.relocate(f.agent, join(f.root, 'missing'))).rejects.toThrow('directory does not exist')
    await expect(f.ctx.workingDirectory.relocate(f.agent, '')).rejects.toThrow('root must not be empty')
    await expect(f.ctx.workingDirectory.relocate(f.agent, f.worktree, { cwd: '' })).rejects.toThrow('cwd must not be empty')
    const controller = new AbortController()
    controller.abort(new Error('cancelled relocation'))
    await expect(f.ctx.workingDirectory.relocate(f.agent, f.worktree, { signal: controller.signal })).rejects.toThrow('cancelled relocation')
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.root)
    expect(f.ctx.workingDirectory.anchorsOf(f.agent.session)).toEqual([f.root])
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
  })

  it('returns root and cursor to the original project when the entered checkout disappears', async () => {
    await using f = await fixture()
    await f.ctx.workingDirectory.relocate(f.agent, f.worktree, { cwd: 'src' })
    f.notices()
    await rm(f.worktree, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.root)
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.root)
    expect(f.notices()).toEqual([
      `The working directory ${JSON.stringify(join(f.worktree, 'src'))} is unavailable. The working directory is now ${JSON.stringify(f.root)}. ${JSON.stringify(f.root)} is now the workspace root.`,
    ])
  })

  it('restores anchors and root from the log and from a log without anchors', async () => {
    await using f = await fixture()
    await f.ctx.workingDirectory.relocate(f.agent, f.worktree, { cwd: 'src' })
    const restored = f.ctx.sessions.create(SessionId('restored'), { meta: { cwd: f.root }, seed: f.agent.session.snapshotEvents() })
    expect(f.ctx.workingDirectory.rootOf(restored)).toBe(f.worktree)
    expect(f.ctx.workingDirectory.anchorsOf(restored)).toEqual([f.root, f.worktree])
    expect(f.ctx.sessionProjections.snapshot(restored).values.workspaceRoot).toBe(f.worktree)
    const legacy = f.ctx.sessions.create(SessionId('legacy'), { meta: { cwd: f.root } })
    legacy.append('working-directory/change', { cwd: join(f.worktree, 'src') })
    expect(f.ctx.workingDirectory.get(legacy)).toBe(join(f.worktree, 'src'))
    expect(f.ctx.workingDirectory.rootOf(legacy)).toBe(f.root)
    expect(f.ctx.workingDirectory.anchorsOf(legacy)).toEqual([f.root])
  })

  it('falls back to the deployment default for a Session without origin metadata until it relocates', async () => {
    await using f = await fixture()
    const agent = await f.harness.create(SessionId('without-origin'))
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(f.ctx.workingDirectory.defaultDirectory)
    expect(f.ctx.workingDirectory.anchorsOf(agent.session)).toEqual([])
    expect(f.ctx.sessionProjections.snapshot(agent.session).values.workspaceRoot).toBeNull()
    await f.ctx.workingDirectory.relocate(agent, f.worktree)
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(f.worktree)
    expect(f.ctx.workingDirectory.anchorsOf(agent.session)).toEqual([f.worktree])
  })

  it('tests containment lexically on canonical absolute paths', () => {
    expect(within('/repo', '/repo')).toBe(true)
    expect(within('/repo', '/repo/src')).toBe(true)
    expect(within('/repo', '/repo-sibling')).toBe(false)
    expect(within('/repo', '/')).toBe(false)
    expect(within('/repo/src', '/repo')).toBe(false)
  })
})
