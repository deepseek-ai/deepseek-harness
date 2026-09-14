import { Context } from '@deepseek-ai/cordis'
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import * as locators from './snapshot-spill-locators.ts'
import * as commands from '../snapshots/session/session-query-spill/resolve-spill-command.mjs'

it.skipIf(process.platform === 'win32')('resolves the exact spill verifier, retains real failures, and restores the shell', async () => {
  const root = await mkdtemp(join(tmpdir(), "query-spill-'quoted-"))
  const ctx = new Context()
  const disposers: (() => Promise<void>)[] = []
  try {
    for (const fiber of [
      ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 }),
      ctx.plugin(LocalFileSystem, { cwd: root }),
      ctx.plugin(LocalSubprocessRuntime),
      ctx.plugin(LocalBashExecutor),
    ]) {
      disposers.push(() => fiber.dispose())
      await fiber
    }
    const logical = resolve('/tmp/dsh-acp-snap-query-verifier')
    const mapping = ctx.plugin(locators, { root, locatorRoot: logical })
    disposers.push(() => mapping.dispose())
    await mapping
    const saved = await ctx.spillStore.saveText({
      owner: { sessionId: SessionId('query-verifier') },
      source: { kind: 'tool', toolName: 'session_event_read', callId: ToolCallId('query'), label: 'result' },
      suggestedName: 'session_event_read.txt', content: 'request/header session_event_search',
    })
    const adapter = ctx.plugin(commands)
    disposers.push(() => adapter.dispose())
    await adapter
    const command = 'file="' + saved.locator + '"' + "; grep -Fq request/header \"$file\" && grep -Fq session_event_search \"$file\" && printf 'SPILL_CANONICAL_OK\\n'"
    const spec = ctx.shell.resolve({ command })
    const output = await ctx.shell.run(spec)
    expect(output.timedOut).toBe(false)
    expect(output.exitCode).toBe(0)
    expect(output.stdout.text).toBe('SPILL_CANONICAL_OK\n')
    expect(spec.command).toBe(command)
    const other = await ctx.shell.run(ctx.shell.resolve({ command: 'printf ordinary; exit 7' }))
    expect(other.exitCode).toBe(7)
    expect(other.stdout.text).toBe('ordinary')
    const unmatched = await ctx.shell.run(ctx.shell.resolve({ command: command + '; exit 9' }))
    expect(unmatched.exitCode).toBe(9)
    expect(unmatched.stderr.text).toContain('No such file')
    const physical = ctx.fs.processPath(await ctx.fs.resolve(saved.locator))
    await rm(physical)
    const missing = await ctx.shell.run(spec)
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stdout.text).toBe('')
    await adapter.dispose()
    const restored = await ctx.shell.run(spec)
    expect(restored.exitCode).not.toBe(0)
    expect(restored.stderr.text).toContain(saved.locator)
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  }
})
