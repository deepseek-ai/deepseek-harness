import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import * as tmuxContext from '@deepseek-ai/dsh-tmux-context'
import type { Config } from '@deepseek-ai/dsh-tmux-context'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

const SIGNAL = new AbortController().signal

/** One `#{...}`-joined tmux reading line for the eight queried fields. */
function tmuxLine(fields: {
  sessionName?: string
  windowIndex?: string
  windowName?: string
  paneIndex?: string
  paneId?: string
  windowActive?: string
  paneActive?: string
  windowLayout?: string
} = {}): string {
  return [
    fields.sessionName ?? '0',
    fields.windowIndex ?? '1',
    fields.windowName ?? 'node',
    fields.paneIndex ?? '2',
    fields.paneId ?? '%90',
    fields.windowActive ?? '1',
    fields.paneActive ?? '0',
    fields.windowLayout ?? 'd517,270x71,0,0{135x71,0,0,87,134x71,136,0[134x35,136,0,90,134x35,136,36,93]}',
  ].join('\\t')
}

function runResult(stdout: string, overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 60_000,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

/** A scriptable fake `ctx.shell` recording the command it was asked to run. */
class FakeBash extends ShellExecutor {
  commands: string[] = []
  result: ShellRunResult = runResult(`${tmuxLine()}\n`)
  runError?: Error
  resolveError?: Error

  override resolve(request: ShellExecRequest): ShellExecSpec {
    if (this.resolveError) throw this.resolveError
    return {
      command: request.command,
      workdir: request.workdir ?? '/work',
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      signal: request.signal,
      sandboxPolicy: request.sandboxPolicy,
    }
  }
  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.commands.push(spec.command)
    if (this.runError) throw this.runError
    return this.result
  }
  override start(): ShellProcess {
    throw new Error('tmux-context must never start a background job')
  }
}

async function mount(config: Config, withBash: true): Promise<{ ctx: Context; bash: FakeBash }>
async function mount(config?: Config, withBash?: boolean): Promise<{ ctx: Context; bash: FakeBash | undefined }>
async function mount(
  config: Config = {},
  withBash = false,
): Promise<{ ctx: Context; bash: FakeBash | undefined }> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  let bash: FakeBash | undefined
  if (withBash) {
    await ctx.plugin(FakeBash)
    bash = ctx.shell as FakeBash
  }
  await ctx.plugin(tmuxContext, config)
  return { ctx, bash }
}

function sessionAgent(session: Session, id = 'agent'): Agent {
  const agent: Agent = {
    id: SessionId(id),
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('tmux-context must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return agent
}

function openMessageTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function contextTexts(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'tmux-context') {
      texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return texts
}

async function fire(
  ctx: Context,
  agent: Agent,
  turn: number,
  step: number,
  signal: AbortSignal = SIGNAL,
): Promise<void> {
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('tmux-context injection', () => {
  it('injects the tmux location on the first step of a turn', async () => {
    const { ctx } = await mount({}, true)
    const session = Session.create(SessionId('first'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toEqual([
      'tmux location (turn 1):\n'
      + 'session 0, window 1 "node", pane 2 %90\n'
      + 'window active=1, pane active=0, '
      + 'layout d517,270x71,0,0{135x71,0,0,87,134x71,136,0[134x35,136,0,90,134x35,136,36,93]}',
    ])
    const event = session.snapshotEvents().at(-1)
    if (event?.type !== 'user/message') throw new Error('missing tmux context')
    // `snapshot` form: one named contribution carrying exactly the reading the
    // model saw, so a consumer attributes it without re-splitting prose.
    expect(event.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'tmux-context',
      form: 'snapshot',
      sections: [{ name: 'tmux-context' }],
    })
    expect(event.surfaceOp).toBe('append')
  })

  it('queries the pane this process runs in and matches its controlling tty', async () => {
    const { ctx, bash } = await mount({}, true)
    const session = Session.create(SessionId('command'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(bash.commands).toHaveLength(1)
    const command = bash.commands[0]!
    expect(command).toContain('[ -n "$TMUX_PANE" ]')
    expect(command).toContain('tmux display-message -t "$TMUX_PANE" -p')
    // Guards against an inherited $TMUX_PANE: the pane's tty must equal this
    // process's controlling tty (resolved for this exact pid).
    expect(command).toContain(`ps -o tty= -p ${process.pid}`)
    expect(command).toContain('#{pane_tty}')
    expect(command).toContain('[ "$pane_tty" = "/dev/$self_tty" ]')
  })

  it('does not run on later steps of a turn', async () => {
    const { ctx, bash } = await mount({}, true)
    const session = Session.create(SessionId('later-step'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 2)

    expect(bash.commands).toHaveLength(0)
    expect(contextTexts(session)).toHaveLength(0)
  })

  it('re-injects a new turn only when tmux state changed', async () => {
    const { ctx, bash } = await mount({}, true)
    const session = Session.create(SessionId('change'))
    const agent = sessionAgent(session)

    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Same state on turn 2: suppressed.
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(contextTexts(session)).toHaveLength(1)

    // Moved pane on turn 3: re-injected.
    bash.result = runResult(`${tmuxLine({ windowName: 'shell', paneId: '%12' })}\n`)
    openMessageTurn(session, 3)
    await fire(ctx, agent, 3, 1)

    const texts = contextTexts(session)
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('tmux location (turn 3):')
    expect(texts[1]).toContain('window 1 "shell", pane 2 %12')
  })

  it('honors a positive refresh interval between injections', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { ctx, bash } = await mount({ refreshIntervalMs: 10_000 }, true)
    const session = Session.create(SessionId('interval'))
    const agent = sessionAgent(session)

    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Changed state but inside the interval: suppressed, and never queried.
    bash.result = runResult(`${tmuxLine({ paneId: '%99' })}\n`)
    vi.setSystemTime(5_000)
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)
    expect(contextTexts(session)).toHaveLength(1)
    expect(bash.commands).toHaveLength(1)

    // Past the interval: queried and re-injected.
    vi.setSystemTime(12_000)
    openMessageTurn(session, 3)
    await fire(ctx, agent, 3, 1)
    expect(contextTexts(session)).toHaveLength(2)
    expect(bash.commands).toHaveLength(2)
  })
})

describe('tmux-context prior-reading resilience', () => {
  it('treats a prior non-text plugin reading as absent and injects afresh', async () => {
    const { ctx, bash } = await mount({}, true)
    const session = Session.create(SessionId('prior-non-text'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    session.append('user/message', createUserMessage({
      content: [{ type: 'reasoning', text: 'not a location' }],
      source: { kind: 'plugin', plugin: 'tmux-context' },
    }), { surfaceOp: 'append' })

    await fire(ctx, agent, 1, 1)

    expect(bash.commands).toHaveLength(1)
    expect(contextTexts(session).at(-1)).toContain('tmux location (turn 1):')
  })

  it('treats a prior single-line plugin reading (no newline) as empty state', async () => {
    const { ctx, bash } = await mount({}, true)
    const session = Session.create(SessionId('prior-single-line'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'single line, no newline' }],
      source: { kind: 'plugin', plugin: 'tmux-context' },
    }), { surfaceOp: 'append' })

    await fire(ctx, agent, 1, 1)

    // Empty prior state never equals the multi-line reading, so it re-injects.
    expect(bash.commands).toHaveLength(1)
    expect(contextTexts(session).at(-1)).toContain('tmux location (turn 1):')
  })
})

describe('tmux-context no-op paths', () => {
  it('is a no-op when no bash executor is mounted', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('no-bash'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
  })

  it('is a no-op when the tmux query exits nonzero (outside tmux, or an inherited env whose tty does not match the pane)', async () => {
    const { ctx, bash } = await mount({}, true)
    bash.result = runResult('', { exitCode: 1 })
    const session = Session.create(SessionId('outside-tmux'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
  })

  it('is a no-op when the reading has the wrong field count', async () => {
    const { ctx, bash } = await mount({}, true)
    bash.result = runResult('0\\t1\\tnode\n')
    const session = Session.create(SessionId('malformed'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
  })

  it('is a no-op when the pane id is empty', async () => {
    const { ctx, bash } = await mount({}, true)
    bash.result = runResult(`${tmuxLine({ paneId: '' })}\n`)
    const session = Session.create(SessionId('empty-pane'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
  })

  it('warns and injects nothing when the executor rejects the run', async () => {
    const { ctx, bash } = await mount({}, true)
    bash.runError = new Error('bash executor unavailable')
    const warn = vi.spyOn(ctx.logger, 'warn')
    const session = Session.create(SessionId('run-rejected'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bash executor unavailable'))
  })

  it('warns and injects nothing when the executor rejects the command at resolve', async () => {
    const { ctx, bash } = await mount({}, true)
    bash.resolveError = new Error('command denied by policy')
    const warn = vi.spyOn(ctx.logger, 'warn')
    const session = Session.create(SessionId('resolve-rejected'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('command denied by policy'))
  })

  it('reports a non-Error rejection in the warning', async () => {
    const { ctx, bash } = await mount({}, true)
    // Non-Error throw: the executor seam is typed, but a bad impl can reject with anything.
    bash.runError = 'spawn refused' as unknown as Error
    const warn = vi.spyOn(ctx.logger, 'warn')
    const session = Session.create(SessionId('non-error-rejection'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawn refused'))
  })

  it('skips an already-aborted prompt submission', async () => {
    const { ctx } = await mount({}, true)
    const session = Session.create(SessionId('ordering'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    const abort = new AbortController()
    abort.abort()
    await fire(ctx, agent, 1, 1, abort.signal)
    expect(contextTexts(session)).toHaveLength(0)

    await fire(ctx, agent, 1, 1)
    expect(contextTexts(session)).toHaveLength(1)
  })
})

describe('tmux-context configuration', () => {
  it('rejects a negative refresh interval at plugin load', async () => {
    await expect(mount({ refreshIntervalMs: -1 })).rejects.toThrow(
      /refreshIntervalMs must be a non-negative safe integer/,
    )
  })

  it('rejects a non-integer refresh interval at plugin load', async () => {
    await expect(mount({ refreshIntervalMs: 1.5 })).rejects.toThrow(
      /refreshIntervalMs must be a non-negative safe integer/,
    )
  })
})
