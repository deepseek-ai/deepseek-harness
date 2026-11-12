/** User-terminal tools, plugin registration and disposal over the real tool and prompt registries. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TerminalController } from '@deepseek-ai/dsh-api-terminal-controller'
import type { TerminalScreenPage, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as TerminalPanel from '../src/index.ts'
import { SUBAGENT_USER_TERMINALS, registerUserTerminalTools, renderUserScreen, renderUserTerminals } from '../src/tools.ts'
import type { UserTerminals } from '../src/tools.ts'
import { agentFor } from './agent.ts'

const signal = new AbortController().signal
let callNumber = 0

function info(id: string, change: Partial<WebTerminalInfo> = {}): WebTerminalInfo {
  return {
    id: id as WebTerminalId, shell: { name: 'zsh', path: '/bin/zsh', args: ['-i'] }, title: 'zsh', cwd: '/workspace', rows: 24, cols: 80,
    state: 'running', exitCode: null, origin: 'user', control: 'user', ...change,
  }
}

async function registries(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  return ctx
}

function call(ctx: Context, agent: Agent | undefined, name: string, args: unknown) {
  return executeModelToolFixture(ctx, { signal, callId: brandString<ToolCallId>(`panel-${++callNumber}`), name, arguments: args, ...agent === undefined ? {} : { agent } })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function terminals(listed: WebTerminalInfo[]) {
  const page: TerminalScreenPage = { text: 'npm ERR! missing script: dev', totalLines: 3, lineBegin: 0, lineEnd: 1, truncated: false }
  const fake = {
    list: vi.fn((_session: SessionId) => listed),
    readScreen: vi.fn(async () => page),
    inspectActivity: vi.fn<UserTerminals['inspectActivity']>(async () => 'busy'),
  } satisfies UserTerminals
  return fake
}

describe('user terminal tools', () => {
  it('lists the terminals the person controls with whether a command runs', async () => {
    const ctx = await registries()
    const fake = terminals([
      info('user-a'), info('user-b', { title: 'logs', cwd: '/var/log' }), info('user-c', { state: 'exited', exitCode: 0 }),
      info('user-d', { title: 'fish' }), info('agent-a', { origin: 'agent', control: 'agent' }),
      info('taken', { origin: 'agent', control: 'user', title: 'dev server' }),
    ])
    fake.inspectActivity.mockResolvedValueOnce('busy').mockResolvedValueOnce('idle').mockResolvedValueOnce('unknown').mockRejectedValueOnce(new Error('closing'))
    await ctx.plugin({ inject: ['tools'], apply: (child: Context) => { registerUserTerminalTools(child, fake, 1000) } })
    const agent = agentFor(ctx, 'session')
    const listed = await call(ctx, agent, 'user_terminal_list', {})
    expect(fake.list).toHaveBeenCalledWith(agent.id)
    expect(listed).toMatchObject({
      isError: false,
      value: [
        { id: 'user-a', title: 'zsh', cwd: '/workspace', running: 'yes' },
        { id: 'user-b', title: 'logs', cwd: '/var/log', running: 'no' },
        { id: 'user-c', running: 'no' },
        { id: 'user-d', title: 'fish', running: 'unknown' },
        { id: 'taken', title: 'dev server', running: 'unknown' },
      ],
    })
    expect(text(listed)).toBe([
      'user-a · zsh · /workspace · command running: yes',
      'user-b · logs · /var/log · command running: no',
      'user-c · zsh · /workspace · command running: no',
      'user-d · fish · /workspace · command running: unknown',
      'taken · dev server · /workspace · command running: unknown',
    ].join('\n'))
  })

  it('reads a user terminal screen and refuses terminals the Agent controls or that do not exist', async () => {
    const ctx = await registries()
    const fake = terminals([info('user-a'), info('agent-a', { origin: 'agent', control: 'agent' })])
    await ctx.plugin({ inject: ['tools'], apply: (child: Context) => { registerUserTerminalTools(child, fake, 1000) } })
    const agent = agentFor(ctx, 'session')
    const read = await call(ctx, agent, 'user_terminal_read', { id: 'user-a' })
    expect(fake.readScreen).toHaveBeenCalledWith(agent, 'user-a', { offset: 0, count: 500, maxBytes: 1000 })
    expect(text(read)).toBe('npm ERR! missing script: dev\n[lines: 0-1 of 3]')
    await call(ctx, agent, 'user_terminal_read', { id: 'user-a', lines: 20 })
    expect(fake.readScreen).toHaveBeenLastCalledWith(agent, 'user-a', { offset: 0, count: 20, maxBytes: 1000 })
    expect(text(await call(ctx, agent, 'user_terminal_read', { id: 'agent-a' }))).toContain('No user terminal has id agent-a')
    expect(text(await call(ctx, agent, 'user_terminal_read', { id: 'gone' }))).toContain('call user_terminal_list for current ids')
    expect(text(await call(ctx, agent, 'user_terminal_read', { id: 'user-a', lines: 0 }))).toContain('lines must be a positive integer')
    expect(text(await call(ctx, undefined, 'user_terminal_list', {}))).toContain('require an initiating agent')
    const child = agentFor(ctx, 'child', { subagent: true })
    expect(text(await call(ctx, child, 'user_terminal_list', {}))).toContain(SUBAGENT_USER_TERMINALS)
    expect(text(await call(ctx, child, 'user_terminal_read', { id: 'user-a' }))).toContain(SUBAGENT_USER_TERMINALS)
    expect(fake.list).not.toHaveBeenCalledWith(child.id)
    expect(ctx.tools.get('user_terminal_list')?.presentCall?.({})).toMatchObject({ card: 'generic', title: 'List user terminals', kind: 'read' })
    expect(ctx.tools.get('user_terminal_read')?.presentCall?.({ id: 'user-a' })).toMatchObject({ card: 'generic', title: 'Read user terminal user-a', kind: 'read' })
  })

  it('renders empty lists, empty screens and bounded screens', () => {
    expect(renderUserTerminals([])).toBe('(no user terminals)')
    expect(renderUserScreen({ text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false }, 100)).toBe('(empty screen)\n[lines: 0-0 of 0]')
    expect(renderUserScreen({ text: 'tail', totalLines: 9, lineBegin: 0, lineEnd: 1, truncated: true }, 100)).toBe('tail\n[lines: 0-1 of 9]\n[output truncated]')
    const bounded = renderUserScreen({ text: 'x'.repeat(100), totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false }, 60)
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(60)
    expect(bounded).toMatch(/^x+\n\[lines: 0-1 of 1\]\n\[output truncated\]$/u)
    const page = { text: '终端'.repeat(40), totalLines: 123_456_789_012_345, lineBegin: 123_456_789_012_000, lineEnd: 123_456_789_012_345, truncated: true }
    const fixed = '\n[lines: 123456789012000-123456789012345 of 123456789012345]\n[output truncated]'
    for (const limit of [Buffer.byteLength(fixed) - 1, 64]) {
      const tiny = renderUserScreen(page, limit)
      expect(Buffer.byteLength(tiny)).toBeLessThanOrEqual(limit)
      expect(fixed.endsWith(tiny)).toBe(true)
    }
    expect(renderUserScreen(page, Buffer.byteLength(fixed))).toBe(fixed)
    expect(renderUserScreen(page, Buffer.byteLength(fixed) + 3)).toBe(`端${fixed}`)
  })
})

describe('plugin', () => {
  async function composed(config: Partial<TerminalPanel.Config>) {
    const ctx = await registries()
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/workspace' })
    // The Service registers itself on construction; the plugin's injection waits for it.
    const controller = new TerminalController(ctx, {
      shellCandidates: [], maxTerminals: 8, maxAgentTerminals: 4, maxCols: 500, maxRows: 200, scrollback: 1000, maxBufferedBytes: 2_097_152,
      maxInputBytes: 65_536, disposeGraceMs: 1000, unattendedTimeoutMs: 0, activityPollIntervalMs: 30_000, cleanupRetryMs: 60_000,
    })
    const fiber = ctx.plugin(TerminalPanel, TerminalPanel.Config(config))
    await fiber.await()
    return { ctx, fiber, controller }
  }

  it('opens registry sessions through the terminal controller under the Session sandbox policy', async () => {
    const { ctx, controller } = await composed({})
    const open = vi.spyOn(controller, 'openForAgent').mockRejectedValue(new Error('no shell in this test'))
    const owner = agentFor(ctx, 'session')
    await ctx.agents.register(owner)
    await expect(ctx.terminals.spawn(owner, { type: 'shell', name: 'watch' })).rejects.toThrow('no shell in this test')
    expect(open.mock.calls[0]?.[0]).toBe(owner)
    expect(open.mock.calls[0]?.[1]).toMatchObject({ title: 'watch', policy: { mode: 'workspace-write', workspaceRoot: '/workspace' } })
  })

  it('registers the shell backend, guidance and user tools, and removes them on disposal', async () => {
    const { ctx, fiber } = await composed({})
    expect(ctx.terminals.listBackends()).toEqual(['shell'])
    expect(ctx.tools.get('user_terminal_list')).toBeDefined()
    expect(ctx.tools.get('user_terminal_read')).toBeDefined()
    const prompt = await ctx.systemPrompt.assemble({})
    expect(prompt.sections.find(section => section.name === 'tool:pty-panel')?.text).toBe(TerminalPanel.GUIDANCE)
    await fiber.dispose()
    expect(ctx.terminals.listBackends()).toEqual([])
    expect(ctx.tools.get('user_terminal_list')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble({})).sections.map(section => section.name)).not.toContain('tool:pty-panel')
  })

  it('omits the user tools when reading user terminals is off and rejects inconsistent timing', async () => {
    const { ctx } = await composed({ readUserTerminals: false })
    expect(ctx.terminals.listBackends()).toEqual(['shell'])
    expect(ctx.tools.get('user_terminal_list')).toBeUndefined()
    const loaded = await registries()
    await loaded.plugin(TerminalSessionService)
    for (const [timing, message] of [
      [{ promptSilenceMs: 5000 }, 'promptSilenceMs must not exceed idleSilenceMs'],
      [{ idleSilenceMs: 40_000 }, 'idleSilenceMs must not exceed timeoutMs'],
      [{ startupSilenceMs: 20_000 }, 'startupSilenceMs must not exceed startupTimeoutMs'],
    ] as const) {
      expect(() => { TerminalPanel.apply(loaded, TerminalPanel.Config(timing)) }).toThrow(message)
    }
  })
})
