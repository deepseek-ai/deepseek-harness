/** Workspace roots: anchors registered by relocation, the root the cursor selects, and the context both reach the model through. */
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { within } from '../src/within.ts'

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
    // Relocation registers the deployment fallback first, so leaving the checkout later selects it.
    const fallback = await realpath(f.ctx.workingDirectory.defaultDirectory)
    await f.ctx.workingDirectory.relocate(agent, f.worktree)
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(f.worktree)
    expect(f.ctx.workingDirectory.anchorsOf(agent.session)).toEqual([fallback, f.worktree])
  })

  it('registers the deployment fallback of a Session without origin metadata as its first anchor and returns to it', async () => {
    await using f = await fixture()
    const agent = await f.harness.create(SessionId('without-origin-recovery'))
    const fallback = await realpath(f.ctx.workingDirectory.defaultDirectory)
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(fallback)
    expect(f.ctx.workingDirectory.anchorsOf(agent.session)).toEqual([fallback])
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(fallback)
    await f.ctx.workingDirectory.relocate(agent, f.worktree, { cwd: 'src' })
    expect(f.ctx.workingDirectory.anchorsOf(agent.session)).toEqual([fallback, f.worktree])
    f.harness.claim(agent, 'next-step', 1)
    await rm(f.worktree, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(fallback)
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(fallback)
    expect(f.ctx.workingDirectory.get(agent.session)).toBe(fallback)
  })

  it('recovers a Session whose header spells the original project through a symlink onto the canonical project', async () => {
    await using f = await fixture()
    const link = join(dirname(f.root), 'link')
    await symlink(f.root, link)
    const agent = await f.harness.create(SessionId('linked-origin'), {}, { cwd: link })
    expect(f.ctx.workingDirectory.anchorsOf(agent.session)).toEqual([link])
    await f.ctx.workingDirectory.relocate(agent, f.worktree, { cwd: 'src' })
    f.harness.claim(agent, 'next-step', 1)
    await rm(f.worktree, { recursive: true })
    // The recovery destination is canonical and no anchor contains it, so it joins the anchors and becomes the root.
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(f.root)
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(f.root)
    expect(f.ctx.workingDirectory.anchorsOf(agent.session)).toEqual([link, f.worktree, f.root])
    expect(f.harness.claim(agent, 'next-step', 1).map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))).toEqual([
      `The working directory ${JSON.stringify(join(f.worktree, 'src'))} is unavailable. The working directory is now ${JSON.stringify(f.root)}. ${JSON.stringify(f.root)} is now the workspace root.`,
    ])
  })

  it('keeps the previous root when a Session with a symlinked header returns to the original project by that spelling', async () => {
    await using f = await fixture()
    const link = join(dirname(f.root), 'link-return')
    await symlink(f.root, link)
    const agent = await f.harness.create(SessionId('linked-origin-return'), {}, { cwd: link })
    await f.ctx.workingDirectory.relocate(agent, f.worktree)
    // Documented limitation: the canonical project is not an anchor until recovery registers it.
    await expect(f.ctx.workingDirectory.set(agent, link)).resolves.toBe(f.root)
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(f.worktree)
  })

  it('passes the checkout a source works in on to a Session starting inside it, and only the directory otherwise', async () => {
    await using f = await fixture()
    const src = join(f.worktree, 'src')
    await f.ctx.workingDirectory.relocate(f.agent, f.worktree, { cwd: src })
    // Starting inside the source's checkout registers it; the child header still records the original project.
    const inside = await f.harness.create(SessionId('inherits-checkout'), {}, { cwd: f.root })
    await expect(f.ctx.workingDirectory.inherit(inside, f.agent.session, { cwd: src }))
      .resolves.toEqual({ root: f.worktree, cwd: src })
    expect(f.ctx.workingDirectory.anchorsOf(inside.session)).toEqual([f.root, f.worktree])
    expect(inside.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
      .toEqual([expect.objectContaining({ data: { cwd: src, anchor: f.worktree } })])
    // Starting outside the source's checkout sets the directory and keeps the original project as the root.
    const outside = await f.harness.create(SessionId('starts-outside'), {}, { cwd: f.root })
    const packages = join(f.root, 'packages')
    await expect(f.ctx.workingDirectory.inherit(outside, f.agent.session, { cwd: packages }))
      .resolves.toEqual({ root: f.root, cwd: packages })
    expect(f.ctx.workingDirectory.anchorsOf(outside.session)).toEqual([f.root])
    expect(outside.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
      .toEqual([expect.objectContaining({ data: { cwd: packages } })])
    // The source's other anchors are not passed on: a later change into one leaves the child's root alone.
    await f.ctx.workingDirectory.set(inside, f.root)
    await f.ctx.workingDirectory.relocate(f.agent, f.nested)
    await f.ctx.workingDirectory.set(inside, join(f.nested, 'src'))
    expect(f.ctx.workingDirectory.rootOf(inside.session)).toBe(f.root)
    // A missing directory is refused before anything is committed.
    await expect(f.ctx.workingDirectory.inherit(outside, f.agent.session, { cwd: join(f.root, 'missing') })).rejects.toThrow('directory does not exist')
  })

  it('passes no root on from a source whose root is its original project or the deployment fallback', async () => {
    await using f = await fixture()
    // The source works in its original project: the child's own header already registers it.
    const child = await f.harness.create(SessionId('same-project'), {}, { cwd: f.root })
    const foo = join(f.root, 'packages', 'foo')
    await expect(f.ctx.workingDirectory.inherit(child, f.agent.session, { cwd: foo })).resolves.toEqual({ root: f.root, cwd: foo })
    expect(child.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
      .toEqual([expect.objectContaining({ data: { cwd: foo } })])
    // A source without a recorded project reports the deployment fallback, which is no anchor to pass on:
    // the started Session only sets its directory and registers nothing.
    const bare = await f.harness.create(SessionId('bare-source'))
    const started = await f.harness.create(SessionId('bare-child'))
    await expect(f.ctx.workingDirectory.inherit(started, bare.session, { cwd: f.outside }))
      .resolves.toEqual({ root: f.ctx.workingDirectory.defaultDirectory, cwd: f.outside })
    expect(f.ctx.workingDirectory.anchorsOf(started.session)).toEqual([])
    expect(started.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
      .toEqual([expect.objectContaining({ data: { cwd: f.outside } })])
  })

  it('keeps the original project as the root when it is more specific than the inherited checkout', async () => {
    await using f = await fixture()
    const packages = join(f.root, 'packages')
    // The source relocated into a checkout enclosing the project the child's header records.
    const source = await f.harness.create(SessionId('enclosing-source'), {}, { cwd: packages })
    await f.ctx.workingDirectory.relocate(source, f.root)
    const child = await f.harness.create(SessionId('enclosed-child'), {}, { cwd: packages })
    const foo = join(packages, 'foo')
    await expect(f.ctx.workingDirectory.inherit(child, source.session, { cwd: foo })).resolves.toEqual({ root: packages, cwd: foo })
    expect(f.ctx.workingDirectory.anchorsOf(child.session)).toEqual([packages, f.root])
    expect(f.ctx.workingDirectory.rootOf(child.session)).toBe(packages)
  })

  it('tests containment lexically on canonical absolute paths', () => {
    expect(within('/repo', '/repo')).toBe(true)
    expect(within('/repo', '/repo/src')).toBe(true)
    expect(within('/repo', '/repo-sibling')).toBe(false)
    expect(within('/repo', '/')).toBe(false)
    expect(within('/repo/src', '/repo')).toBe(false)
  })
})
