import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalSendOperation,
  TerminalSendRequest,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalWaitReason,
} from '@deepseek-ai/dsh-terminal'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as ToolPwshPersistent from '@deepseek-ai/dsh-tool-pwsh-persistent'

const contexts: Context[] = []
let callNumber = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function agent(ctx: Context, cwd: string | undefined): Agent {
  const id = SessionId(`persistent-pwsh-owner-${callNumber}`)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], {
    version: 0,
    id,
    createdAt: 0,
    isSeeded: false,
    ...cwd === undefined ? {} : { cwd },
  })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function call(
  ctx: Context,
  owner: Agent | undefined,
  command: string,
  signal = new AbortController().signal,
) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`persistent-pwsh-${++callNumber}`),
    name: 'pwsh',
    arguments: { command },
    ...owner === undefined ? {} : { agent: owner },
  })
}

type StubMode =
  | 'normal'
  | 'prompt-only'
  | 'prompt-crlf'
  | 'empty-read'
  | 'stalled-read'
  | 'exit'
  | 'signal-exit'
  | 'unknown-exit'
  | 'wait-for-abort'
  | 'end-on-abort'
  | 'idle-then-normal'
  | 'large'
  | 'nonzero'
  | 'torn-status'
  | 'finish-torn-status'
  | 'end-only'
  | 'init-exit'
  | 'init-timeout'
  | 'spawn-error'
  | 'send-error'
  | 'prompt-after-idle'
  | 'incremental-fallback'
  | 'empty-page-after-latest'
  | 'paged-scrollback'
  | 'with-echo'
  | 'exit-after-send'
  | 'prompt-collision'

const START_PATTERN = /__DSH_PERSISTENT_PWSH_START_[^_]+(?:-[^_]+)*__/
const END_PATTERN = /__DSH_PERSISTENT_PWSH_END_[^:]+:/

class StubTerminalSession implements TerminalBackendSession {
  readonly motd = '__DSH_PERSISTENT_PWSH_PROMPT__ '
  readonly pid = 123
  statusValue: TerminalSessionStatus = { kind: 'running' }
  scrollback = this.motd
  closed: string[] = []
  mode: StubMode
  sends = 0
  pendingText = ''
  historyTruncated = false
  throwOnSend = false

  constructor(mode: StubMode) {
    this.mode = mode
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    this.sends += 1
    if (request.text.startsWith('function prompt')) {
      if (this.mode === 'init-exit') {
        this.statusValue = { kind: 'exited', exitCode: 1, signal: null }
        return this.operation(Promise.resolve(this.result('', 'session_exit')))
      }
      if (this.mode === 'init-timeout') {
        return this.operation(Promise.resolve(this.result('', 'timeout')))
      }
      return this.operation(Promise.resolve(this.result(this.motd, 'stdin_read')))
    }
    if (this.mode === 'send-error') throw new Error('stub send failed')
    if (this.throwOnSend) throw new Error('PTY session has exited')
    if (this.mode === 'wait-for-abort' || this.mode === 'end-on-abort') {
      const done = new Promise<ReturnType<StubTerminalSession['result']>>((resolve) => {
        request.signal?.addEventListener('abort', () => {
          const start = START_PATTERN.exec(request.text)?.[0]
          const end = END_PATTERN.exec(request.text)?.[0]
          const output = this.mode === 'end-on-abort'
            ? `${start ?? ''}\ninterrupted\n${end ?? ''}130\n${this.motd}`
            : 'partial output'
          this.scrollback += output
          resolve(this.result(output, 'stdin_read'))
        }, { once: true })
      })
      return this.operation(done)
    }
    if (this.mode === 'idle-then-normal') {
      this.mode = 'normal'
      this.pendingText = request.text
      return this.operation(Promise.resolve(this.result('', 'inferred_idle')))
    }
    if (this.mode === 'prompt-after-idle') {
      if (request.text.length > 0) {
        const start = START_PATTERN.exec(request.text)?.[0]
        const output = `${start ?? ''}\npartial syntax output\n`
        this.scrollback += output
        return this.operation(Promise.resolve(this.result(output, 'inferred_idle')))
      }
      const output = `pwsh: syntax error\n${this.motd}`
      this.scrollback += output
      return this.operation(Promise.resolve(this.result(output, 'stdin_read')))
    }
    if (this.mode === 'prompt-only' || this.mode === 'prompt-crlf') {
      const newline = this.mode === 'prompt-crlf' ? '\r\n' : '\n'
      const output = `pwsh: syntax error${newline}${this.motd}${newline}`
      this.scrollback += output
      return this.operation(Promise.resolve(this.result(output, 'stdin_read')))
    }
    const sent = request.text.length > 0 ? request.text : this.pendingText
    this.pendingText = ''
    const start = START_PATTERN.exec(sent)?.[0]
    const end = END_PATTERN.exec(sent)?.[0]
    if (this.mode === 'with-echo') {
      // The PSReadLine echo renders the submitted wrapper before the real
      // markers; the tool must strip it from the captured result.
      const output = `${sent}\n${start ?? ''}\nhello from stub\n${end ?? ''}0\n${this.motd}`
      this.scrollback += output
      return this.operation(Promise.resolve(this.result(output, 'stdin_read')))
    }
    if (this.mode === 'exit-after-send') {
      // A fast `exit` settles the send with an echoed wrapper (marker end,
      // no status digits) while the exit event is still in flight; the shell
      // flips to exited before the tool's next poll, exactly like the real
      // ConPTY backend. The tool must re-observe status instead of sending.
      const output = `${sent}\n${start ?? ''}\n`
      this.scrollback += output
      const settled = this.result(output, 'inferred_idle')
      this.statusValue = { kind: 'exited', exitCode: 9, signal: null }
      this.throwOnSend = true
      return this.operation(Promise.resolve(settled))
    }
    if (this.mode === 'incremental-fallback') {
      const incremental = `${start ?? ''}\nincrement\n${this.motd}`
      return this.operation(Promise.resolve(this.result(this.motd, 'stdin_read')), incremental)
    }
    if (this.mode === 'torn-status') {
      const output = `${start ?? ''}\nhello from stub\n${end ?? ''}`
      this.scrollback += output
      this.mode = 'finish-torn-status'
      return this.operation(Promise.resolve(this.result(output, 'inferred_idle')))
    }
    if (this.mode === 'finish-torn-status') {
      const output = `7\n${this.motd}`
      this.scrollback += output
      return this.operation(Promise.resolve(this.result(output, 'stdin_read')))
    }
    if (this.mode === 'end-only') {
      const output = `recovered output\n${end ?? ''}0\n${this.motd}`
      this.scrollback += output
      return this.operation(Promise.resolve(this.result(output, 'stdin_read')))
    }
    const commandOutput = this.mode === 'large'
      ? 'x'.repeat(100)
      : this.mode === 'nonzero' ? ''
        : this.mode === 'prompt-collision' ? this.motd
          : 'hello from stub'
    const exitCode = this.mode === 'nonzero' ? 7 : 0
    const output = `${start ?? ''}\n${commandOutput}\n${end ?? ''}${exitCode}\n${this.motd}`
    this.scrollback += output
    if (this.mode === 'exit' || this.mode === 'signal-exit' || this.mode === 'unknown-exit') {
      const exitedOutput = `${start ?? ''}\nhello from stub\n`
      this.scrollback = this.scrollback.slice(0, -output.length) + exitedOutput
      this.statusValue = this.mode === 'signal-exit'
        ? { kind: 'exited', exitCode: null, signal: 'SIGTERM' }
        : this.mode === 'exit'
          ? { kind: 'exited', exitCode: 9, signal: null }
          : { kind: 'exited', exitCode: null, signal: null }
      return this.operation(Promise.resolve(this.result(exitedOutput, 'session_exit')))
    }
    return this.operation(Promise.resolve(this.result(output, 'stdin_read')))
  }

  read(request: TerminalReadRequest) {
    if (this.mode === 'empty-read') {
      return { text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false }
    }
    if (this.mode === 'stalled-read') {
      return { text: 'stalled', totalLines: 1, lineBegin: 0, lineEnd: 0, truncated: false }
    }
    if (this.mode === 'empty-page-after-latest' && (request.offset ?? 0) > 0) {
      return { text: '', totalLines: 2, lineBegin: 1, lineEnd: 1, truncated: false }
    }
    const lines = this.scrollback.split('\n')
    if (this.mode === 'paged-scrollback') {
      const offset = request.offset ?? 0
      const end = lines.length - offset
      const start = Math.max(0, end - 3)
      const returnedLines = end - start
      return {
        text: lines.slice(start, end).join('\n'),
        totalLines: lines.length,
        lineBegin: offset,
        lineEnd: offset + returnedLines,
        truncated: this.historyTruncated,
      }
    }
    return {
      text: this.scrollback,
      totalLines: this.mode === 'empty-page-after-latest' ? lines.length + 1 : lines.length,
      lineBegin: 0,
      lineEnd: this.mode === 'empty-page-after-latest' ? 1 : lines.length,
      truncated: this.historyTruncated,
    }
  }

  signal(_signal: TerminalSignal) {
    return Promise.resolve({ delivered: true as const, targetPgid: 123 })
  }

  status() {
    return this.statusValue
  }

  async close(reason: string) {
    this.closed.push(reason)
    this.statusValue = { kind: 'exited', exitCode: 0, signal: null }
  }

  private result(viewport: string, waitReason: TerminalWaitReason) {
    return { viewport, waitReason, sessionStatus: this.statusValue, truncated: false }
  }

  private operation(done: Promise<ReturnType<StubTerminalSession['result']>>, delta = ''): TerminalSendOperation {
    return {
      done,
      readOutput: () => ({ delta, truncated: false }),
      cancel: () => false,
    }
  }
}

function stubBackend(initialMode: StubMode = 'normal') {
  const sessions: StubTerminalSession[] = []
  const backend: TerminalBackend = {
    type: 'stub',
    async spawn() {
      if (initialMode === 'spawn-error') throw new Error('stub spawn failed')
      const session = new StubTerminalSession(initialMode)
      sessions.push(session)
      return session
    },
  }
  return { backend, sessions }
}

async function setup(
  config: ToolPwshPersistent.Config = { backendType: 'stub' },
  initialMode: StubMode = 'normal',
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TerminalSessionService)
  const stub = stubBackend(initialMode)
  ctx.terminals.registerBackend(stub.backend)
  const fiber = await ctx.plugin(ToolPwshPersistent, config)
  return { ctx, stub, fiber, owner: agent(ctx, '/workspace') }
}

describe('tool-pwsh-persistent', () => {
  it('registers a configurable schema and reuses one owner shell', async () => {
    const { ctx, owner, stub, fiber } = await setup({
      backendType: 'stub',
      description: 'deployment-specific persistent shell',
    })
    const schema = ctx.tools.schemas()[0]
    expect(ctx.tools.schemas().map(item => item.name)).toEqual(['pwsh'])
    expect(schema?.description).toBe('deployment-specific persistent shell')
    expect(schema?.parameters).toMatchObject({
      required: ['command'],
      properties: { command: { type: 'string' } },
    })
    expect(ctx.tools.get('pwsh')?.presentCall?.({ command: 'pwd' }))
      .toEqual({ card: 'terminal', title: 'pwd' })

    expect(text(await call(ctx, owner, 'Write-Output one'))).toBe('hello from stub')
    expect(text(await call(ctx, owner, 'Write-Output two'))).toBe('hello from stub')
    expect(stub.sessions).toHaveLength(1)
    expect(stub.sessions[0]?.sends).toBe(3)

    const ownerWithoutCwd = agent(ctx, undefined)
    expect(text(await call(ctx, ownerWithoutCwd, 'pwd'))).toBe('hello from stub')
    expect(stub.sessions).toHaveLength(2)

    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.tools.get('pwsh')).toBeUndefined()
  })

  it('strips the echoed wrapper from captured output', async () => {
    const { ctx, owner, stub } = await setup({ backendType: 'stub' })
    await call(ctx, owner, 'warm up')
    stub.sessions[0]!.mode = 'with-echo'
    const result = text(await call(ctx, owner, 'Write-Output hi'))
    expect(result).toBe('hello from stub')
    expect(result).not.toContain('__DSH_PERSISTENT_PWSH_START_')
    expect(result).not.toContain('__DSH_PERSISTENT_PWSH_END_')
    expect(result).not.toContain('Invoke-Expression')
  })

  it('preserves command output that equals the private shell prompt', async () => {
    const { ctx, owner, stub } = await setup({ backendType: 'stub' })
    await call(ctx, owner, 'warm up')
    const session = stub.sessions[0]!

    session.mode = 'prompt-collision'
    expect(text(await call(ctx, owner, 'complete prompt collision'))).toBe(session.motd)
  })

  it('reports the exit path when the shell exits between send settlement and the next poll', async () => {
    const { ctx, owner, stub } = await setup({ backendType: 'stub' })
    await call(ctx, owner, 'warm up')
    const session = stub.sessions[0]!
    session.mode = 'exit-after-send'

    const result = text(await call(ctx, owner, 'exit'))
    expect(result).toContain('[shell exited: code 9]')
    expect(result).toContain('next pwsh call starts from the workspace')
    expect(session.closed).toContain('persistent pwsh shell exited')

    expect(text(await call(ctx, owner, 'Write-Output "$PWD"'))).toBe('hello from stub')
    expect(stub.sessions).toHaveLength(2)
  })

  it('handles inferred idle, prompt fallback, shell exit, clipping, and cleanup', async () => {
    const { ctx, owner, stub, fiber } = await setup({
      backendType: 'stub',
      maxOutputChars: 10,
    })
    await call(ctx, owner, 'warm up')
    const session = stub.sessions[0]!

    session.mode = 'idle-then-normal'
    expect(text(await call(ctx, owner, 'silent then complete'))).toContain('hello from')

    session.mode = 'incremental-fallback'
    session.scrollback = ''
    expect(text(await call(ctx, owner, 'incremental fallback'))).toBe('increment')

    session.mode = 'prompt-only'
    const promptFallback = text(await call(ctx, owner, 'bad {'))
    expect(promptFallback).toContain('pwsh: synt')
    expect(promptFallback).not.toContain('DSH_PERSISTENT_PWSH_PROMPT')

    session.mode = 'prompt-crlf'
    session.scrollback = ''
    const crlfPromptFallback = text(await call(ctx, owner, 'bad {'))
    expect(crlfPromptFallback).toContain('pwsh: synt')
    expect(crlfPromptFallback).not.toContain('DSH_PERSISTENT_PWSH_PROMPT')

    session.mode = 'end-only'
    session.scrollback = ''
    const missingStart = text(await call(ctx, owner, 'recover marker'))
    expect(missingStart).toContain('recovered')
    expect(missingStart).toContain('beginning of this command output was dropped')
    expect(missingStart).toContain('<response clipped>')

    session.mode = 'large'
    expect(text(await call(ctx, owner, 'large'))).toContain('<response clipped>')

    session.mode = 'nonzero'
    expect(text(await call(ctx, owner, 'false'))).toBe('[exit code: 7]')

    session.mode = 'exit'
    const exited = text(await call(ctx, owner, 'exit'))
    expect(exited).toContain('hello from')
    expect(exited).toContain('[shell exited: code 9]')
    expect(exited).not.toContain('[exit code: 9]')
    expect(exited).toContain('next pwsh call starts from the workspace')
    expect(session.closed).toContain('persistent pwsh shell exited')

    await call(ctx, owner, 'new shell')
    expect(stub.sessions).toHaveLength(2)
    const replacement = stub.sessions[1]!
    replacement.mode = 'signal-exit'
    expect(text(await call(ctx, owner, 'kill shell')))
      .toContain('[shell killed by signal: SIGTERM]')

    await call(ctx, owner, 'another shell')
    expect(stub.sessions).toHaveLength(3)
    const externallyClosed = ctx.terminals.list(owner)[0]?.sessionId
    expect(externallyClosed).toBeDefined()
    await ctx.terminals.kill(owner, externallyClosed!, 'external cleanup')
    await fiber.dispose()
    expect(stub.sessions[2]?.closed).toEqual(['external cleanup'])
  })

  it('waits for status digits after a torn completion marker', async () => {
    const { ctx, owner, stub } = await setup({ backendType: 'stub', maxOutputChars: 1_000 })
    await call(ctx, owner, 'warm up')
    stub.sessions[0]!.mode = 'torn-status'
    stub.sessions[0]!.scrollback = ''

    expect(text(await call(ctx, owner, 'torn status'))).toBe('hello from stub\n[exit code: 7]')
  })

  it('reports a shell exit when the backend has no code or signal', async () => {
    const { ctx, owner, stub } = await setup({ backendType: 'stub' })
    await call(ctx, owner, 'warm up')
    stub.sessions[0]!.mode = 'unknown-exit'

    expect(text(await call(ctx, owner, 'exit without status'))).toContain('[shell exited]')
  })

  it('marks a short missing-prefix result and tolerates exhausted scrollback pages', async () => {
    const { ctx, owner, stub } = await setup({ backendType: 'stub', maxOutputChars: 1_000 })
    await call(ctx, owner, 'warm up')
    const session = stub.sessions[0]!

    session.mode = 'end-only'
    session.scrollback = ''
    expect(text(await call(ctx, owner, 'missing start')))
      .toContain('beginning of this command output was dropped')

    session.mode = 'empty-read'
    expect(text(await call(ctx, owner, 'empty page'))).toContain('hello from stub')

    session.mode = 'stalled-read'
    expect(text(await call(ctx, owner, 'stalled page'))).toContain('hello from stub')

    session.mode = 'empty-page-after-latest'
    expect(text(await call(ctx, owner, 'empty continuation page'))).toContain('hello from stub')
  })

  it('assembles retained output across backward scrollback pages', async () => {
    const { ctx, owner, stub } = await setup({ backendType: 'stub', maxOutputChars: 1_000 })
    await call(ctx, owner, 'warm up')
    const session = stub.sessions[0]!
    session.mode = 'paged-scrollback'
    session.scrollback = 'older one\nolder two\nolder three\nolder four\n'

    expect(text(await call(ctx, owner, 'paged output'))).toBe('hello from stub')
  })

  it('sanitizes a prompt fallback reached after multiple polling rounds', async () => {
    const { ctx, owner, stub } = await setup({ backendType: 'stub', maxOutputChars: 1_000 })
    await call(ctx, owner, 'warm up')
    const session = stub.sessions[0]!
    session.mode = 'prompt-after-idle'
    session.scrollback = ''
    const result = text(await call(ctx, owner, 'bad {'))
    expect(result).toContain('partial syntax output')
    expect(result).toContain('pwsh: syntax error')
    expect(result).not.toContain('DSH_PERSISTENT_PWSH_PROMPT')
    expect(result).not.toContain('DSH_PERSISTENT_PWSH_START')
  })

  it('does not attribute old scrollback truncation to a complete current command', async () => {
    const { ctx, owner, stub } = await setup({ backendType: 'stub', maxOutputChars: 1_000 })
    await call(ctx, owner, 'warm up')
    stub.sessions[0]!.historyTruncated = true
    const result = text(await call(ctx, owner, 'short command'))
    expect(result).toBe('hello from stub')
    expect(result).not.toContain('<response clipped>')
    expect(result).not.toContain('beginning of this command output was dropped')
  })

  it('closes a timed-out shell and reports bounded partial output', async () => {
    const { ctx, owner, stub } = await setup({ backendType: 'stub', timeoutMs: 10 })
    await call(ctx, owner, 'warm up')
    stub.sessions[0]!.mode = 'wait-for-abort'
    const result = await call(ctx, owner, 'hang')
    expect(text(result)).toContain('timed out after 0 seconds or experienced an OOM error')
    expect(text(result)).toContain('partial output')
    expect(text(result)).toContain('next pwsh call starts from the workspace')
    expect(stub.sessions[0]?.closed).toContain('persistent pwsh command timed out')
  })

  it.each(['wait-for-abort', 'end-on-abort'] as const)(
    'cancels %s work, resets the shell, and releases a queued call',
    async (mode) => {
      const { ctx, owner, stub } = await setup({ backendType: 'stub', timeoutMs: 5_000 })
      await call(ctx, owner, 'warm up')
      stub.sessions[0]!.mode = mode
      const controller = new AbortController()
      const cancelled = call(ctx, owner, 'hang', controller.signal)
      const queued = call(ctx, owner, 'after cancellation')
      setTimeout(() => {
        controller.abort(new Error('caller stopped'))
      }, 5)

      expect((await cancelled).isError).toBe(true)
      expect(text(await queued)).toBe('hello from stub')
      expect(stub.sessions[0]?.closed).toContain('persistent pwsh command aborted')
      expect(stub.sessions).toHaveLength(2)
    },
  )

  it.each(['init-exit', 'init-timeout'] as const)(
    'fails initialization and closes the unusable shell for %s',
    async (mode) => {
      const { ctx, owner, stub } = await setup({ backendType: 'stub' }, mode)
      expect((await call(ctx, owner, 'pwd')).isError).toBe(true)
      expect(stub.sessions[0]?.closed).toContain('persistent pwsh initialization failed')
    },
  )

  it('clears a failed spawn without trying to close an unpublished shell', async () => {
    const { ctx, owner, stub } = await setup({ backendType: 'stub' }, 'spawn-error')
    expect((await call(ctx, owner, 'pwd')).isError).toBe(true)
    expect(stub.sessions).toHaveLength(0)
  })

  it('resets a cached shell after startSend fails', async () => {
    const { ctx, owner, stub } = await setup()
    await call(ctx, owner, 'warm up')
    stub.sessions[0]!.mode = 'send-error'
    expect((await call(ctx, owner, 'fails')).isError).toBe(true)
    expect(stub.sessions[0]?.closed).toContain('persistent pwsh send failed')
    expect(text(await call(ctx, owner, 'recovers'))).toBe('hello from stub')
    expect(stub.sessions).toHaveLength(2)
  })

  it('cancels and awaits a pending shell spawn when the plugin is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    const spawnStarted = Promise.withResolvers<undefined>()
    const spawnAborted = Promise.withResolvers<undefined>()
    ctx.terminals.registerBackend({
      type: 'slow',
      spawn: spec => new Promise((_resolve, reject) => {
        spawnStarted.resolve(undefined)
        spec.signal?.addEventListener('abort', () => {
          spawnAborted.resolve(undefined)
          const reason: unknown = spec.signal?.reason
          reject(reason instanceof Error
            ? reason
            : new Error('slow PTY spawn aborted', { cause: reason }))
        }, { once: true })
      }),
    })
    const fiber = await ctx.plugin(ToolPwshPersistent, { backendType: 'slow' })
    const owner = agent(ctx, '/workspace')
    const running = call(ctx, owner, 'pwd')
    await spawnStarted.promise
    await fiber.dispose()
    await spawnAborted.promise
    expect((await running).isError).toBe(true)
    expect(ctx.terminals.list(owner)).toEqual([])
  })

  it('rejects invalid config and invalid calls', async () => {
    const { ctx, owner, stub } = await setup()
    expect((await call(ctx, undefined, 'pwd')).isError).toBe(true)
    expect(text(await call(ctx, owner, ' '))).toContain('command must be a non-empty string')

    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    expect((await call(ctx, owner, 'pwd', controller.signal)).isError).toBe(true)
    expect(stub.sessions).toHaveLength(0)

    expect(() => {
      ToolPwshPersistent.apply(new Context(), { backendType: '' })
    }).toThrow('backendType must be non-empty')
    expect(() => {
      ToolPwshPersistent.apply(new Context(), { timeoutMs: 0 })
    }).toThrow('timeoutMs must be a positive safe integer')
    expect(() => {
      ToolPwshPersistent.apply(new Context(), { maxOutputChars: 0 })
    }).toThrow('maxOutputChars must be a positive safe integer')
    expect(() => {
      ToolPwshPersistent.apply(new Context(), { description: ' ' })
    }).toThrow('description must be non-empty')
  })
})
