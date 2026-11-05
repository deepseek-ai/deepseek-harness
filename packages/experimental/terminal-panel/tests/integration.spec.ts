/** A real shell in a sidebar terminal, driven through the terminal registry with the shipped readiness rules. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { TerminalController } from '@deepseek-ai/dsh-api-terminal-controller'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import { PanelTerminalBackend } from '../src/backend.ts'
import { Config } from '../src/config.ts'
import { agentFor } from './agent.ts'

const config = Config({ startupSilenceMs: 200, promptSilenceMs: 150, probeIntervalMs: 150, idleSilenceMs: 800, timeoutMs: 8000 })

describe.skipIf(process.platform === 'win32')('sidebar terminals in a real shell', () => {
  it('keeps shell state across sends, reports a quiet command as inferred_idle and closes the terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-terminal-panel-'))
    const ctx = new Context()
    try {
      provideWorkingDirectoryFixture(ctx, root)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(TerminalSessionService)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: root })
      const controller = new TerminalController(ctx, {
        shell: { path: '/bin/sh', name: 'sh', args: ['-i'] }, shellCandidates: [], maxTerminals: 8, maxAgentTerminals: 4, maxCols: 500, maxRows: 200,
        scrollback: 1000, maxBufferedBytes: 2_097_152, maxInputBytes: 65_536, disposeGraceMs: 1000, unattendedTimeoutMs: 0,
        activityPollIntervalMs: 30_000, cleanupRetryMs: 60_000,
      })
      ctx.terminals.registerBackend(new PanelTerminalBackend({
        open: (agent, request, signal) => controller.openForAgent(agent, request, signal),
        policy: session => ctx.sandboxPolicy.resolve({ session }),
      }, config))
      const owner = agentFor(ctx, 'panel-session', { cwd: root })
      await ctx.agents.register(owner)

      const opened = await ctx.terminals.spawn(owner, { type: 'shell', name: 'dev server', cwd: root })
      expect(controller.list(owner.id)).toEqual([expect.objectContaining({
        title: 'dev server', cwd: root, origin: 'agent', control: 'agent', sandboxMode: 'danger-full-access', state: 'running',
      })])
      const send = (text: string) => ctx.terminals.startSend(owner, opened.sessionId, { text, submit: true }).done
      expect(await send('export KEEP=panel')).toMatchObject({ waitReason: 'stdin_read', sessionStatus: { kind: 'running' } })
      const printed = await send('printf "keep=%s\\n" "$KEEP"')
      expect(printed.waitReason).toBe('stdin_read')
      expect(printed.viewport).toContain('\nkeep=panel\n')
      expect(await send('sleep 5')).toMatchObject({ waitReason: 'inferred_idle' })
      expect(ctx.terminals.read(owner, opened.sessionId, {}).text).toContain('keep=panel')

      expect(await ctx.terminals.kill(owner, opened.sessionId)).toBe(true)
      expect(controller.list(owner.id)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
