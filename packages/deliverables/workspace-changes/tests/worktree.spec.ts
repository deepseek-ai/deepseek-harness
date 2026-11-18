/** Turns recorded in the checkout the Session works in: a worktree entered through the working-directory service. */
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import * as WorkspaceChanges from '../src/index.ts'
import { changes, endTurn, git, mutate, scratchDir, settle, startTurn, toolCall } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

function agentFor(ctx: Context, session: Session): Agent {
  const scope = ctx.plugin(() => {})
  return {
    id: session.id, session, options: {}, status: 'idle', ctx: scope.ctx, model: unsupportedModel(),
    inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
}

it('snapshots the worktree the Session entered, lists paths relative to it, and leaves the original checkout out', async () => {
  // Production headers record canonical paths; anchors compare as recorded, so the fixture does too.
  const main = await realpath(await scratchDir('dsh-workspace-changes-worktree-', cleanups))
  git(main, 'init', '-q', '-b', 'main')
  await writeFile(join(main, 'a.txt'), 'main\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-q', '-m', 'init')
  await mkdir(join(main, '.agents', 'worktrees'), { recursive: true })
  await writeFile(join(main, '.agents', 'worktrees', '.gitignore'), '*\n')
  const worktree = join(main, '.agents', 'worktrees', 'x')
  git(main, 'worktree', 'add', '-q', '-b', 'x', worktree)

  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: main })
  await ctx.plugin(WorkingDirectoryService, {})
  await ctx.plugin(WorkspaceChanges, {} as WorkspaceChanges.Config)
  const session = ctx.sessions.create(brandString<SessionId>('worktree-turns'), { meta: { cwd: main } })
  const agent = agentFor(ctx, session)
  await ctx.workingDirectory.set(agent, worktree)

  // A shell-only edit inside the worktree is a change of the worktree's repository.
  startTurn(session, 1)
  await settle(ctx, session)
  await writeFile(join(worktree, 'a.txt'), 'edited in the worktree\n')
  // Someone else edits the original checkout meanwhile; it is not this turn's work.
  await writeFile(join(main, 'a.txt'), 'edited in the original checkout\n')
  toolCall(session, 1, 'bash', { command: 'edit' })
  endTurn(session, 1)
  await settle(ctx, session)

  // A file-tool edit lists its path relative to the worktree, not to the original project.
  startTurn(session, 2)
  await settle(ctx, session)
  await mutate(ctx, session, 2, 'write', {}, join(worktree, 'b.txt'), () => writeFile(join(worktree, 'b.txt'), 'new\n'))
  endTurn(session, 2)
  await settle(ctx, session)

  // Back in the original project, the next turn is snapshotted there again.
  await ctx.workingDirectory.set(agent, main)
  startTurn(session, 3)
  await settle(ctx, session)
  await writeFile(join(main, 'a.txt'), 'edited again in the original checkout\n')
  toolCall(session, 3, 'bash', { command: 'edit' })
  endTurn(session, 3)
  await settle(ctx, session)

  const snapshot = { before: expect.stringMatching(/^[0-9a-f]+$/) as string, after: expect.stringMatching(/^[0-9a-f]+$/) as string }
  expect(changes(ctx, session)).toEqual([
    { turn: 1, cwd: worktree, total: 1, added: 1, deleted: 1, files: [{ path: 'a.txt', display: 'a.txt', added: 1, deleted: 1 }], snapshot },
    { turn: 2, cwd: worktree, total: 1, added: 1, deleted: 0, files: [{ path: 'b.txt', display: 'b.txt', added: 1, deleted: 0 }], snapshot },
    { turn: 3, cwd: main, total: 1, added: 1, deleted: 1, files: [{ path: 'a.txt', display: 'a.txt', added: 1, deleted: 1 }], snapshot },
  ])
})
