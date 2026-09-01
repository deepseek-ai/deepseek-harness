import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { fsHarness, waitForIdle } from './harness.ts'

/** Key-gated smoke for a real model driving the local read/write/edit tools. */

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

const SYSTEM = 'You are a coding assistant. Use the write tool to create files, the read tool to inspect '
  + 'them, and the edit tool for literal replacements. Read a file before editing it. Keep replies terse.'

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('fs tools with-key smoke', () => {
  it('creates, reads, then edits a file — verified on disk', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-fs-e2e-'))
    ctx = await fsHarness(workdir, SYSTEM)
    // agentLoop.create prepares a session with no cwd, so the provider default
    // (config.cwd = workdir) is the workspace.
    const agent = ctx.agentLoop.create(SessionId('fs-e2e'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text:
      'Create a file named note.txt containing exactly the line: status: draft. '
      + 'Then read it back, then edit it to replace the literal word draft with final. '
      + 'Tell me when done.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Assert the filesystem effect independently of the model response.
    const content = await readFile(join(workdir, 'note.txt'), 'utf8')
    expect(content).toContain('status: final')
    expect(content).not.toContain('draft')

    // The log records real read/write/edit tool calls (not bash).
    const calls = agent.session.snapshotEvents().filter(e => e.type === 'tool/call').map(e => e.data.name)
    expect(calls).toContain('write')
    expect(calls).toContain('read')
    expect(calls).toContain('edit')
  }, 180_000)

  it('resolves a relative path against the per-session cwd (factory meta.cwd)', async () => {
    // config.cwd is the harness workdir, but the agent's SESSION cwd is a
    // different dir; the write must land in the SESSION dir, proving the tool
    // passes the per-session cwd (not the backend default).
    const configDir = await mkdtemp(join(tmpdir(), 'dsh-fs-e2e-cfg-'))
    workdir = configDir
    const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-fs-e2e-session-'))
    try {
      ctx = await fsHarness(configDir, SYSTEM)
      const handle = await ctx.agents.create({
        sessionId: SessionId(`fs-e2e-cwd-${Date.now()}`),
        meta: { cwd: sessionDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text:
        'Use the write tool to create a file named where.txt containing exactly the line: here. Tell me when done.' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, handle.agent)

      // The file is in the SESSION dir, not the config dir.
      expect(await readFile(join(sessionDir, 'where.txt'), 'utf8')).toContain('here')
      await expect(readFile(join(configDir, 'where.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(sessionDir, { recursive: true, force: true })
    }
  }, 180_000)
})
