/** Real file-tool mutations and their before-copies after a Session directory change. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as StrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as WorkspaceChanges from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

it.each(['write', 'edit', 'str_replace_editor'] as const)('captures the resolved %s target before mutation, without a repository', async (name) => {
  const origin = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-directory-')))
  cleanups.push(() => rm(origin, { recursive: true, force: true }))
  const current = join(origin, 'current')
  await mkdir(current)
  await writeFile(join(origin, 'witness.txt'), 'origin\n')
  await writeFile(join(current, 'witness.txt'), 'before\n')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ToolFs)
  await ctx.plugin(StrReplaceEditor)
  await ctx.plugin(WorkspaceChanges)
  const args = name === 'write'
    ? { file_path: 'witness.txt', content: 'after\n' }
    : name === 'edit'
      ? { file_path: 'witness.txt', old_string: 'before', new_string: 'after' }
      : { command: 'str_replace', path: join(current, 'witness.txt'), old_str: 'before', new_str: 'after' }
  ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('mutation', name, args), textResponse('done')]))
  const agent = await harness.create(SessionId('capture-current'), { provider: 'mock', model: 'mock' }, { cwd: origin })
  await ctx.workingDirectory.set(agent, current)
  // A later directory change cannot alter the filesystem's already resolved mutation target.
  const changeDirectory = async <T>(next: () => T): Promise<Awaited<T>> => {
    await ctx.workingDirectory.set(agent, origin)
    return await next()
  }
  ctx.on('fs/write-intent', (_target, _actor, next) => changeDirectory(next))
  ctx.on('fs/edit-intent', (_target, _actor, next) => changeDirectory(next))
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'update witness' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  expect(await readFile(join(origin, 'witness.txt'), 'utf8')).toBe('origin\n')
  expect(await readFile(join(current, 'witness.txt'), 'utf8')).toBe('after\n')
  expect(ctx.workingDirectory.get(agent.session)).toBe(origin)
  const events = agent.session.snapshotEvents()
  const result = events.find(event => event.type === 'tool/result')
  expect(result).toMatchObject({ data: { message: { isError: false } } })
  if (name !== 'str_replace_editor') expect(result).toMatchObject({ data: { meta: { path: join(current, 'witness.txt') } } })
  const announcement = events.findLast(event => event.type === 'workspace/changes')
  expect(announcement).toBeDefined()
  const summary = ctx.workspaceChanges.summary(agent.id, announcement!.seq)
  expect(summary).toMatchObject({ cwd: origin, total: 1, files: [{ path: 'current/witness.txt', added: 1, deleted: 1 }] })
  expect(summary!.snapshot).toBeUndefined()
  expect(await ctx.workspaceChanges.diff(agent.id, announcement!.seq, 0, new AbortController().signal)).toMatchObject({ kind: 'text', hunks: [{ lines: ['-before', '+after'] }] })
})

it('delegates filesystem intents without a recorded tool actor and preserves a rejecting policy', async () => {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(WorkspaceChanges)
  const target = await ctx.fs.resolve('witness.txt')
  const bare = vi.fn(() => undefined)
  await ctx.waterfall('fs/write-intent', target, undefined, bare)
  await ctx.waterfall('fs/edit-intent', target, {}, bare)
  expect(bare).toHaveBeenCalledTimes(2)
  ctx.on('fs/write-intent', () => { throw new Error('policy denied') })
  await expect(ctx.waterfall('fs/write-intent', target, undefined, bare)).rejects.toThrow('policy denied')
  expect(bare).toHaveBeenCalledTimes(2)
})
