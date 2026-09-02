import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime, { parseCommand, type CommandDefinition } from '@deepseek-ai/dsh-commands'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'

function command(name: string, text = `ran:${name}`): CommandDefinition {
  return {
    name,
    description: `command ${name}`,
    handler: () => ({ kind: 'success', text }),
  }
}

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  return ctx
}

/** Mint a scope whose key is a live agent (real session: the executor logs lifecycle events on it). */
async function mintAgentScope(ctx: Context, name: string): Promise<{ scope: Scope; agent: Agent }> {
  const session = ctx.sessions.create(SessionId(name))
  const agent = { id: session.id, session } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['commands'] }))
  return { scope, agent }
}

/** The lifecycle slice of one agent's log (boundary markers stripped). */
function lifecycleOf(agent: Agent): Array<{ type: string; data: unknown }> {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'command/run' || event.type === 'command/done')
    .map(event => ({ type: event.type, data: event.data }))
}

describe('parseCommand()', () => {
  it.each([
    ['/goal', { name: 'goal', rawInput: '' }],
    ['/goal create the thing', { name: 'goal', rawInput: ' create the thing' }],
    ['/goal\ncreate the thing', { name: 'goal', rawInput: '\ncreate the thing' }],
    ['/goal_name-2\t x ', { name: 'goal_name-2', rawInput: '\t x ' }],
  ] as const)('parses %j without normalizing trailing input', (line, expected) => {
    expect(parseCommand(line)).toEqual(expected)
  })

  it.each(['goal', ' /goal', '/', '/Goal', '/goal/path', '/goal🔥'])('rejects non-command boundary %j', (line) => {
    expect(parseCommand(line)).toBeUndefined()
  })
})

describe('CommandRuntime', () => {
  it('lists immutable global descriptors with input metadata', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    const definition: CommandDefinition = {
      name: 'inspect',
      description: 'Inspect state',
      input: { hint: '<target>' },
      handler: () => ({ kind: 'success' }),
    }
    ctx.commands.register(definition)

    const listed = ctx.commands.list(agent)
    expect(listed).toEqual([{
      name: 'inspect',
      description: 'Inspect state',
      input: { hint: '<target>' },
    }])
    expect(Object.isFrozen(listed)).toBe(true)
    expect(Object.isFrozen(listed[0])).toBe(true)
    expect(Object.isFrozen(listed[0]?.input)).toBe(true)
    expect(ctx.commands.find(agent, 'inspect')).toMatchObject({ name: 'inspect' })
    expect(ctx.commands.find(agent, 'missing')).toBeUndefined()
  })

  it('sorts distinct effective command names', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register(command('zeta'))
    ctx.commands.register(command('alpha'))
    ctx.commands.register(command('middle'))
    expect(ctx.commands.list(agent).map(item => item.name)).toEqual(['alpha', 'middle', 'zeta'])
  })

  it('uses agent-scoped shadows and removes them with their scope', async () => {
    const ctx = await mount()
    const { scope, agent } = await mintAgentScope(ctx, 'a')
    const other = { id: 'other' as SessionId } as Agent
    ctx.commands.register(command('shared', 'global'))
    scope.ctx.commands.register(command('shared', 'scoped'))

    expect(ctx.commands.list(agent).map(item => item.name)).toEqual(['shared'])
    expect(ctx.commands.find(agent, 'shared')?.handler).toBeDefined()
    expect(ctx.commands.list(other).map(item => item.name)).toEqual(['shared'])
    expect((await ctx.commands.execute(agent, '/shared', [], new AbortController().signal))?.result)
      .toEqual({ kind: 'success', text: 'scoped' })

    await scope.dispose()
    expect((await ctx.commands.execute(agent, '/shared', [], new AbortController().signal))?.result.text).toBe('global')
  })

  it('removes a registration when its contributing plugin fiber is disposed', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.commands.register(command('temporary'))
    }, { inject: ['commands'] }))
    expect(ctx.commands.find(agent, 'temporary')).toBeDefined()

    await fiber.dispose()

    expect(ctx.commands.find(agent, 'temporary')).toBeUndefined()
  })

  it('rejects duplicates within one layer while allowing a scoped shadow', async () => {
    const ctx = await mount()
    const { scope } = await mintAgentScope(ctx, 'a')
    ctx.commands.register(command('same'))
    expect(() => ctx.commands.register(command('same'))).toThrow(/agent\.ctx/)
    scope.ctx.commands.register(command('same'))
    expect(() => scope.ctx.commands.register(command('same'))).toThrow(/already registered in this scope/)
  })

  it('notifies on registration and disposal while containing broken observers', async () => {
    const ctx = await mount()
    const changed = vi.fn()
    ctx.on('commands/change', changed)
    const dispose = ctx.commands.register(command('live'))
    dispose()
    dispose()
    expect(changed).toHaveBeenCalledTimes(2)

    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    ctx.on('commands/change', () => { throw new Error('observer threw') })
    // oxlint-disable-next-line typescript/no-misused-promises -- exercises rejected-listener containment
    ctx.on('commands/change', () => Promise.reject(new Error('observer rejected')))
    const afterFailures = vi.fn()
    ctx.on('commands/change', afterFailures)
    const removeContained = ctx.commands.register(command('contained'))
    const { agent } = await mintAgentScope(ctx, 'a')
    expect(ctx.commands.find(agent, 'contained')).toBeDefined()
    expect(afterFailures).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('commands/change listener threw: Error: observer threw')
      expect(warn).toHaveBeenCalledWith('commands/change listener rejected: Error: observer rejected')
    })
    removeContained()
    expect(ctx.commands.find(agent, 'contained')).toBeUndefined()
    expect(afterFailures).toHaveBeenCalledTimes(2)
  })

  it('rejects non-string descriptions and input hints with boundary diagnostics', async () => {
    const ctx = await mount()
    expect(() => ctx.commands.register({
      ...command('description-type'),
      description: undefined,
    } as unknown as CommandDefinition)).toThrow('command "description-type" description must be a string')
    expect(() => ctx.commands.register({
      ...command('hint-type'),
      input: { hint: 42 },
    } as unknown as CommandDefinition)).toThrow('command "hint-type" input hint must be a string')
    expect(() => ctx.commands.register({
      ...command('input-type'),
      input: null,
    } as unknown as CommandDefinition)).toThrow('command "input-type" input hint must be a string')
  })

  it('passes exact invocation context and detaches valid handler results', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    const seen = vi.fn(() => ({ kind: 'success' as const, text: 'ok' }))
    ctx.commands.register({ name: 'run', description: 'Run it', handler: seen })
    const controller = new AbortController()

    const execution = await ctx.commands.execute(agent, '/run  untouched ', [], controller.signal)

    expect(execution?.result).toEqual({ kind: 'success', text: 'ok' })
    expect(execution?.commandId).toBeTruthy()
    expect(Object.isFrozen(execution)).toBe(true)
    expect(Object.isFrozen(execution?.result)).toBe(true)
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({
      agent,
      rawInput: '  untouched ',
      signal: controller.signal,
    }))
    await expect(ctx.commands.execute(agent, 'run', [], controller.signal)).resolves.toBeUndefined()
    await expect(ctx.commands.execute(agent, '/missing', [], controller.signal)).resolves.toBeUndefined()
  })

  it('stops awaiting an aborted handler and handles an already-aborted signal', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    let release!: (result: { kind: 'success'; text: string }) => void
    ctx.commands.register({
      name: 'wait',
      description: 'Wait',
      handler: () => new Promise((resolve) => { release = resolve }),
    })
    const running = new AbortController()
    const promise = ctx.commands.execute(agent, '/wait', [], running.signal)
    running.abort('operator cancelled command')
    await expect(promise).rejects.toThrow('operator cancelled command')
    release({ kind: 'success', text: 'late' })

    const already = new AbortController()
    already.abort(new Error('already gone'))
    await expect(ctx.commands.execute(agent, '/wait', [], already.signal)).rejects.toThrow('already gone')

    const defaultReason = new AbortController()
    defaultReason.abort({ source: 'test' })
    await expect(ctx.commands.execute(agent, '/wait', [], defaultReason.signal)).rejects.toThrow('command aborted')
  })

  it('propagates an asynchronously rejected handler', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register({
      name: 'reject',
      description: 'Reject',
      handler: () => Promise.reject(new Error('handler rejected')),
    })
    await expect(ctx.commands.execute(agent, '/reject', [], new AbortController().signal))
      .rejects.toThrow('handler rejected')

    ctx.commands.register({
      name: 'reject-value',
      description: 'Reject a non-Error value',
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise untyped plugin normalization
      handler: () => Promise.reject('not an Error'),
    })
    await expect(ctx.commands.execute(agent, '/reject-value', [], new AbortController().signal))
      .rejects.toThrow('command handler rejected with a non-Error value: not an Error')

    const hostile = { toString(): string { throw new Error('cannot render') } }
    ctx.commands.register({
      name: 'reject-hostile',
      description: 'Reject an unrenderable value',
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise hostile plugin normalization
      handler: () => Promise.reject(hostile),
    })
    await expect(ctx.commands.execute(agent, '/reject-hostile', [], new AbortController().signal))
      .rejects.toMatchObject({
        message: 'command handler rejected with a non-Error value: <unrenderable thrown value>',
        cause: hostile,
      })
  })

  it('observes an abort triggered synchronously inside the handler', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    const controller = new AbortController()
    ctx.commands.register({
      name: 'self-abort',
      description: 'Abort before returning',
      handler: () => {
        controller.abort('aborted in handler')
        return { kind: 'success' }
      },
    })
    await expect(ctx.commands.execute(agent, '/self-abort', [], controller.signal))
      .rejects.toThrow('aborted in handler')
  })

  it('returns a detached expected-error result', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register({
      name: 'denied',
      description: 'Denied',
      handler: () => ({ kind: 'error', text: 'not now' }),
    })
    const execution = await ctx.commands.execute(agent, '/denied', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'error', text: 'not now' })
    expect(Object.isFrozen(execution?.result)).toBe(true)

    ctx.commands.register({
      name: 'silent',
      description: 'No output',
      handler: () => ({ kind: 'success' }),
    })
    const silent = await ctx.commands.execute(agent, '/silent', [], new AbortController().signal)
    expect(silent?.result).toEqual({ kind: 'success' })
    expect(Object.isFrozen(silent?.result)).toBe(true)
  })

  it.each([
    [{ ...command('Bad') }, /command name/],
    [{ ...command('empty-description'), description: ' ' }, /description/],
    [{ ...command('empty-hint'), input: { hint: '' } }, /input hint/],
    [{ ...command('bad-handler'), handler: undefined }, /handler/],
  ] as const)('rejects invalid definition %#', async (definition, expected) => {
    const ctx = await mount()
    expect(() => ctx.commands.register(definition as unknown as CommandDefinition)).toThrow(expected)
  })

  it('logs a paired command/run + command/done around a successful handler', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register(command('deploy', 'deployed'))

    const execution = await ctx.commands.execute(agent, '/deploy now', [], new AbortController().signal)

    const lifecycle = lifecycleOf(agent)
    expect(lifecycle).toMatchObject([
      { type: 'command/run', data: { name: 'deploy', args: ' now', source: { kind: 'user' } } },
      { type: 'command/done', data: { kind: 'success', text: 'deployed' } },
    ])
    const ids = lifecycle.map(event => (event.data as { commandId: string }).commandId)
    expect(ids[0]).toBeTruthy()
    expect(ids[0]).toBe(ids[1])
    // The execution's pairing id is the logged one (RPC-level correlation).
    expect(execution?.commandId).toBe(ids[0])
    // Direct log-only appends: no turn is opened for the pair on an idle log.
    expect(agent.session.snapshotEvents().map(event => event.type)).toEqual([
      'command/run', 'command/done',
    ])
  })

  it('preserves an earlier authoritative domain-event reference on successful settlement', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    const source = agent.session.append('turn/start', { turn: 1 })
    ctx.commands.register({
      name: 'linked',
      description: 'Link outcome',
      handler: () => ({ kind: 'success', text: 'linked', sourceEventSeq: source.seq }),
    })

    const execution = await ctx.commands.execute(agent, '/linked', [], new AbortController().signal)

    expect(execution?.result).toEqual({ kind: 'success', text: 'linked', sourceEventSeq: source.seq })
    expect(lifecycleOf(agent)).toMatchObject([
      { type: 'command/run', data: { name: 'linked' } },
      { type: 'command/done', data: { kind: 'success', text: 'linked', sourceEventSeq: source.seq } },
    ])
  })

  it('omits raw input from command/run when an authoritative domain event owns it', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    const seen = vi.fn(() => ({ kind: 'success' as const }))
    ctx.commands.register({
      name: 'private',
      description: 'Record privately',
      recordInput: false,
      handler: seen,
    })

    await ctx.commands.execute(agent, '/private keep this once', [], new AbortController().signal)

    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ rawInput: ' keep this once' }))
    const run = agent.session.snapshotEvents().find(event => event.type === 'command/run')
    expect(run?.type).toBe('command/run')
    expect(run?.type === 'command/run' && Object.hasOwn(run.data, 'args')).toBe(false)
  })

  it('mints distinct monotonic commandIds across executions', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register(command('first'))
    ctx.commands.register(command('second'))
    await ctx.commands.execute(agent, '/first', [], new AbortController().signal)
    await ctx.commands.execute(agent, '/second', [], new AbortController().signal)
    const ids = lifecycleOf(agent)
      .filter(event => event.type === 'command/run')
      .map(event => (event.data as { commandId: string }).commandId)
    expect(new Set(ids).size).toBe(2)
  })

  it('logs command/done kind error for an expected error result', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register({ name: 'denied', description: 'Denied', handler: () => ({ kind: 'error', text: 'not now' }) })
    await ctx.commands.execute(agent, '/denied', [], new AbortController().signal)
    expect(lifecycleOf(agent)).toMatchObject([
      { type: 'command/run', data: { name: 'denied' } },
      { type: 'command/done', data: { kind: 'error', text: 'not now' } },
    ])
  })

  it('logs command/done kind error when the handler throws, and preserves the throw', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register({
      name: 'boom',
      description: 'Throw',
      handler: () => { throw new Error('handler exploded') },
    })
    await expect(ctx.commands.execute(agent, '/boom', [], new AbortController().signal))
      .rejects.toThrow('handler exploded')
    expect(lifecycleOf(agent)).toMatchObject([
      { type: 'command/run', data: { name: 'boom' } },
      { type: 'command/done', data: { kind: 'error', text: 'handler exploded' } },
    ])
  })

  it('logs command/done kind error when the signal aborts a hanging handler', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register({
      name: 'hang',
      description: 'Hang',
      handler: () => new Promise(() => undefined),
    })
    const controller = new AbortController()
    const pending = ctx.commands.execute(agent, '/hang', [], controller.signal)
    // The run append must land before the abort so the pair stays complete.
    await vi.waitFor(() => { expect(lifecycleOf(agent)).toHaveLength(1) })
    controller.abort('operator cancelled command')
    await expect(pending).rejects.toThrow('operator cancelled command')
    await vi.waitFor(() => {
      expect(lifecycleOf(agent)).toMatchObject([
        { type: 'command/run', data: { name: 'hang' } },
        { type: 'command/done', data: { kind: 'error', text: 'operator cancelled command' } },
      ])
    })
  })

  it('logs nothing for admission misses (syntax or unknown name)', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register(command('real'))
    const signal = new AbortController().signal
    await ctx.commands.execute(agent, 'not a command', [], signal)
    await ctx.commands.execute(agent, '/missing', [], signal)
    expect(agent.session.snapshotEvents()).toEqual([])
  })

  it('joins an open turn without wrapping the lifecycle pair in synthetic turns', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register(command('mid'))
    agent.session.append('turn/start', { turn: 1 })
    await ctx.commands.execute(agent, '/mid', [], new AbortController().signal)
    expect(agent.session.snapshotEvents().map(event => event.type)).toEqual([
      'turn/start', 'command/run', 'command/done',
    ])
  })

  it.each([
    [undefined, /CommandResult/],
    [null, /CommandResult/],
    [{}, /CommandResult/],
    [{ kind: 'success', text: 1 }, /success text/],
    [{ kind: 'success', sourceEventSeq: -1 }, /sourceEventSeq/],
    [{ kind: 'success', sourceEventSeq: -0 }, /sourceEventSeq/],
    [{ kind: 'success', sourceEventSeq: 1.5 }, /sourceEventSeq/],
    [{ kind: 'success', sourceEventSeq: '1' }, /sourceEventSeq/],
    [{ kind: 'error', text: '' }, /error text/],
    [{ kind: 'error', text: 1 }, /error text/],
    [{ kind: 'future', text: 'x' }, /unknown result kind/],
  ] as const)('rejects malformed handler result %j', async (output, expected) => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register({
      name: 'broken',
      description: 'Broken',
      handler: () => output as never,
    })
    await expect(ctx.commands.execute(agent, '/broken', [], new AbortController().signal)).rejects.toThrow(expected)
  })
})

describe('image attachments', () => {
  const PNG = 'AAAA'

  function storeOf() {
    let saved = 0
    const store = {
      imageLimits: {
        maxImageBytes: 1024, maxImagesPerMessage: 2, maxMessageImageBytes: 1024,
        maxImagePixels: 1_000_000, maxImageDimension: 2000, mediaTypes: ['image/png'],
      },
      validateImage: vi.fn(() => Promise.resolve()),
      saveImage: vi.fn((input: { mediaType: string; name?: string }) => {
        saved += 1
        return Promise.resolve({
          attachmentId: `att-${saved}`, mediaType: input.mediaType, bytes: 3, width: 1, height: 1,
          ...input.name === undefined ? {} : { name: input.name },
        })
      }),
      validateImageBatch(inputs: readonly unknown[]) {
        const validate = AttachmentStore.prototype as unknown as {
          validateImageBatch(this: unknown, batch: readonly unknown[]): void
        }
        validate.validateImageBatch.call(this, inputs)
      },
      // The real base-class batch method over this double's limits and members.
      saveImages(inputs: readonly unknown[]) {
        return (AttachmentStore.prototype.saveImages as (this: unknown, batch: readonly unknown[]) => Promise<unknown[]>).call(this, inputs)
      },
    }
    return store
  }

  function accepting(handler: CommandDefinition['handler']): CommandDefinition {
    return {
      name: 'vision',
      description: 'accepts images',
      input: { hint: '<objective>', images: true },
      handler,
    }
  }

  it('rejects a boolean-typed images flag violation at registration', async () => {
    const ctx = await mount()
    expect(() => ctx.commands.register({
      ...command('flag-type'),
      input: { hint: 'x', images: 'yes' },
    } as unknown as CommandDefinition)).toThrow('command "flag-type" input images flag must be a boolean')
  })

  it('lists images acceptance on the descriptor and omits a false flag', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register(accepting(() => ({ kind: 'success' })))
    ctx.commands.register({ ...command('plain-input'), input: { hint: 'x', images: false } })
    const byName = new Map(ctx.commands.list(agent).map(descriptor => [descriptor.name, descriptor]))
    expect(byName.get('vision')?.input).toEqual({ hint: '<objective>', images: true })
    expect(byName.get('plain-input')?.input).toEqual({ hint: 'x' })
  })

  it('settles images sent to a non-declaring command as a logged error before the handler', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    ctx.commands.register({ ...command('deploy'), handler })
    const execution = await ctx.commands.execute(
      agent, '/deploy now', [{ mediaType: 'image/png', data: PNG }], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'error', text: '/deploy does not accept image attachments' })
    expect(handler).not.toHaveBeenCalled()
    expect(lifecycleOf(agent)).toMatchObject([
      { type: 'command/run', data: { name: 'deploy' } },
      { type: 'command/done', data: { kind: 'error', text: '/deploy does not accept image attachments' } },
    ])
  })

  it('settles a declaring command as a logged error when no attachment store is composed', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register(accepting(() => ({ kind: 'success' })))
    const execution = await ctx.commands.execute(
      agent, '/vision x', [{ mediaType: 'image/png', data: PNG }], new AbortController().signal)
    expect(execution?.result).toEqual({
      kind: 'error',
      text: '/vision: image attachments are unavailable because no attachment store is composed',
    })
  })

  it('admits and hands the handler frozen ordered image blocks; plain invocations stay empty', async () => {
    const ctx = await mount()
    ctx.provide('attachments', storeOf())
    const { agent } = await mintAgentScope(ctx, 'a')
    const seen = vi.fn((invocation: { attachments: readonly unknown[] }) => {
      expect(Object.isFrozen(invocation.attachments)).toBe(true)
      return { kind: 'success' as const }
    })
    ctx.commands.register(accepting(seen))
    await ctx.commands.execute(agent, '/vision x', [
      { mediaType: 'image/png', data: PNG, name: 'a.png' },
      { mediaType: 'image/png', data: PNG, name: 'b.png' },
    ], new AbortController().signal)
    const invocation = seen.mock.calls[0]?.[0] as { attachments: ReadonlyArray<{ type: string; attachment: { name?: string } }> }
    expect(invocation.attachments.map(block => [block.type, block.attachment.name])).toEqual([
      ['image', 'a.png'], ['image', 'b.png'],
    ])
    await ctx.commands.execute(agent, '/vision y', [], new AbortController().signal)
    expect((seen.mock.calls[1]?.[0] as { attachments: readonly unknown[] }).attachments).toEqual([])
  })

  it('settles an admission limit failure as a logged error result', async () => {
    const ctx = await mount()
    ctx.provide('attachments', storeOf())
    const { agent } = await mintAgentScope(ctx, 'a')
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    ctx.commands.register(accepting(handler))
    const three = [1, 2, 3].map(() => ({ mediaType: 'image/png' as const, data: PNG }))
    const execution = await ctx.commands.execute(agent, '/vision x', three, new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'error', text: 'Image batch exceeds the configured image-count limit.' })
    expect(handler).not.toHaveBeenCalled()
    expect(lifecycleOf(agent).at(-1)).toMatchObject({ type: 'command/done', data: { kind: 'error' } })
  })

  it('honors a cancellation that lands during admission before entering the handler', async () => {
    const ctx = await mount()
    const controller = new AbortController()
    const store = storeOf()
    store.saveImage.mockImplementationOnce((input: { mediaType: string }) => {
      controller.abort('operator cancelled during admission')
      return Promise.resolve({
        attachmentId: 'att-late', mediaType: input.mediaType, bytes: 3, width: 1, height: 1,
      })
    })
    ctx.provide('attachments', store)
    const { agent } = await mintAgentScope(ctx, 'a')
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    ctx.commands.register(accepting(handler))
    await expect(ctx.commands.execute(
      agent, '/vision x', [{ mediaType: 'image/png', data: PNG }], controller.signal,
    )).rejects.toThrow('operator cancelled during admission')
    expect(handler).not.toHaveBeenCalled()
    expect(lifecycleOf(agent).at(-1)).toMatchObject({
      type: 'command/done',
      data: { kind: 'error', text: 'operator cancelled during admission' },
    })
  })

  it('logs and rethrows a non-attachment admission failure', async () => {
    const ctx = await mount()
    const store = storeOf()
    store.saveImage.mockRejectedValueOnce(new Error('disk gone'))
    ctx.provide('attachments', store)
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register(accepting(() => ({ kind: 'success' })))
    await expect(ctx.commands.execute(
      agent, '/vision x', [{ mediaType: 'image/png', data: PNG }], new AbortController().signal,
    )).rejects.toThrow('disk gone')
    expect(lifecycleOf(agent).at(-1)).toMatchObject({
      type: 'command/done',
      data: { kind: 'error', text: 'disk gone' },
    })
  })
})
