// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalPanel } from '../src/client/ApprovalPanel.tsx'
import type { ApprovalComposerProps, ApprovalInjected } from '../src/client/contract/slots.ts'
import { PendingApproval } from '../src/client/contract/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

type ApprovalListener = (
  this: Context,
  request: {
    toolName: string
    callId?: string
    reason?: string
    displayReason?: PendingApproval['displayReason']
    signal?: AbortSignal
  },
  next: () => Promise<'unavailable'>,
) => Promise<unknown>

interface PluginBench {
  readonly ctx: Context
  readonly listener: ApprovalListener
  readonly pending: { getSnapshot(): readonly PendingApproval[] }
  readonly registerPendingInteraction: ReturnType<typeof vi.fn>
  readonly disposeSlot: ReturnType<typeof vi.fn>
  readonly disposeLocale: ReturnType<typeof vi.fn>
  readonly register: ReturnType<typeof vi.fn>
  readonly injectSlot: ReturnType<typeof vi.fn>
  releasePending(): Promise<void>
  registration(): {
    options: {
      select(props: { pendingInteraction: PendingApproval | undefined }): PendingApproval | null
      inject(): ApprovalInjected
    }
    component: unknown
  }
}

async function setupPlugin(): Promise<PluginBench> {
  const ctx = new Context()
  let listener: ApprovalListener | undefined
  let registration: {
    options: {
      select(props: { pendingInteraction: PendingApproval | undefined }): PendingApproval | null
      inject(): ApprovalInjected
    }
    component: unknown
  } | undefined
  const disposeSlot = vi.fn()
  const disposeLocale = vi.fn()
  const pending = new Map<PendingApproval, () => Promise<void>>()
  const registerPendingInteraction = vi.fn((_precedence: (value: PendingApproval) => number) => (
    value: PendingApproval,
    delegate: () => Promise<void>,
  ) => {
    _precedence(value)
    pending.set(value, delegate)
    return () => { pending.delete(value) }
  })
  const register = vi.fn((
    options: NonNullable<typeof registration>['options'],
    component: unknown,
  ) => {
    registration = { options, component }
    return disposeSlot
  })
  const injectSlot = vi.fn((_name: string, mount: () => () => void) => {
    const dispose = ctx.effect(() => mount())
    return () => { void dispose() }
  })
  ctx.provide('remote', {
    $on: (_event: string, callback: ApprovalListener) => {
      listener = callback
      return () => {}
    },
  } as never)
  ctx.provide('sessions', { scopeOf } as never)
  ctx.provide('uiSession', { registerPendingInteraction } as never)
  ctx.provide('slots', { inject: injectSlot, register } as never)
  ctx.provide('locale', {
    register: vi.fn(() => disposeLocale),
    resolveText: (reason: NonNullable<PendingApproval['displayReason']>) => reason.en,
  } as never)

  const fiber = ctx.plugin({ apply })
  await fiber.await()
  if (listener === undefined) throw new Error('approval listener was not registered')
  return {
    ctx,
    listener,
    pending: { getSnapshot: () => [...pending.keys()] },
    registerPendingInteraction,
    disposeSlot,
    disposeLocale,
    register,
    injectSlot,
    async releasePending() {
      const delegates = [...pending.values()]
      pending.clear()
      await Promise.allSettled(delegates.map(delegate => delegate()))
    },
    registration: () => {
      if (registration === undefined) throw new Error('approval slot was not registered')
      return registration
    },
  }
}

const id = (value: string): SessionId => value as SessionId

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PendingApproval', () => {
  it('resolves once, removes its abort listener, and ignores later abort cleanup', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = new PendingApproval(id('s1'), {
      toolName: 'bash',
      callId: 'call-1' as ToolCallId,
      reason: 'needs access',
      signal: controller.signal,
    })

    await pending.answer('allowed-once')

    await expect(pending.result).resolves.toBe('allowed-once')
    expect(pending.sessionId).toBe(id('s1'))
    expect(pending.toolName).toBe('bash')
    expect(pending.callId).toBe('call-1')
    expect(pending.reason).toBe('needs access')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(() => { pending.abort(new Error('late')) }).not.toThrow()
    expect(() => { pending.delegate() }).not.toThrow()
    await expect(pending.answer('rejected')).rejects.toThrow(/already settled/)
  })

  it('rejects with an already-aborted signal reason', async () => {
    const controller = new AbortController()
    const reason = new Error('host cancelled')
    controller.abort(reason)

    const pending = new PendingApproval(id('s1'), {
      toolName: 'read',
      signal: controller.signal,
    })

    await expect(pending.result).rejects.toBe(reason)
  })

  it('uses a stable fallback when an abort signal supplies no reason', async () => {
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal

    const pending = new PendingApproval(id('s1'), { toolName: 'read', signal })

    await expect(pending.result).rejects.toThrow('approval request was aborted')
  })

  it('rejects an unanswered request explicitly without an AbortSignal', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'write' })
    const reason = new Error('scope released')

    pending.abort(reason)

    await expect(pending.result).rejects.toBe(reason)
  })

  it('wraps a non-Error answer settlement failure with its cause', async () => {
    const failure = 'resolve failed'
    const completion = Promise.withResolvers<'allowed-once' | 'rejected'>()
    const withResolvers = vi.spyOn(Promise, 'withResolvers').mockImplementationOnce(() => ({
      promise: completion.promise,
      resolve: () => { throw failure },
      reject: completion.reject,
    }))
    const pending = new PendingApproval(id('s1'), { toolName: 'write' })
    withResolvers.mockRestore()

    const settlement = await pending.answer('allowed-once').catch((error: unknown) => error)

    expect(settlement).toBeInstanceOf(Error)
    expect(settlement).toMatchObject({
      message: 'pending approval settlement failed',
      cause: failure,
    })
    completion.resolve('allowed-once')
    await expect(pending.result).resolves.toBe('allowed-once')
  })
})

describe('approval Remote Event consumer', () => {
  it('delegates an event that has no Agent scope', async () => {
    const bench = await setupPlugin()
    const next = vi.fn(() => Promise.resolve<'unavailable'>('unavailable'))

    await expect(bench.listener.call(bench.ctx, { toolName: 'bash' }, next))
      .resolves.toBe('unavailable')
    expect(next).toHaveBeenCalledOnce()
    expect(bench.pending.getSnapshot()).toEqual([])
    expect(bench.register).toHaveBeenCalledOnce()
  })

  it('publishes one scoped takeover, returns the answer, and keeps stable registrations', async () => {
    const bench = await setupPlugin()
    const scope = createScope(bench.ctx, id('s1'))
    await scope.fiber.await()
    const controller = new AbortController()
    const next = vi.fn(() => Promise.resolve<'unavailable'>('unavailable'))
    const result = bench.listener.call(scope.ctx, {
      toolName: 'bash',
      callId: 'call-1',
      reason: 'needs access',
      displayReason: { en: 'Display reason', zh: '展示原因' },
      signal: controller.signal,
    }, next)
    const pending = bench.pending.getSnapshot()[0]!
    const { options, component } = bench.registration()

    expect(component).toBe(ApprovalPanel)
    expect(pending.displayReason).toEqual({ en: 'Display reason', zh: '展示原因' })
    expect(options.inject().resolveReason(pending.displayReason!)).toBe('Display reason')
    expect(options.select({ pendingInteraction: undefined })).toBeNull()
    expect(options.select({ pendingInteraction: pending })).toBe(pending)
    expect(pending).toMatchObject({
      kind: 'approval',
      sessionId: id('s1'),
      toolName: 'bash',
      callId: 'call-1',
      reason: 'needs access',
    })

    await pending.answer('allowed-once')

    await expect(result).resolves.toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
    expect(bench.pending.getSnapshot()).toEqual([])
    expect(bench.register).toHaveBeenCalledOnce()
    expect(bench.disposeSlot).not.toHaveBeenCalled()
    await scope.fiber.dispose()
  })

  it('propagates request cancellation after removing the pending object', async () => {
    const bench = await setupPlugin()
    const scope = createScope(bench.ctx, id('s1'))
    await scope.fiber.await()
    const controller = new AbortController()
    const reason = new Error('cancelled by host')
    const result = bench.listener.call(scope.ctx, {
      toolName: 'bash',
      signal: controller.signal,
    }, () => Promise.resolve('unavailable'))
    expect(bench.pending.getSnapshot()).toHaveLength(1)

    controller.abort(reason)

    await expect(result).rejects.toBe(reason)
    expect(bench.pending.getSnapshot()).toEqual([])
    expect(bench.disposeSlot).not.toHaveBeenCalled()
    await scope.fiber.dispose()
  })

  it('delegates an active request when its interaction domain unloads', async () => {
    const bench = await setupPlugin()
    const scope = createScope(bench.ctx, id('s1'))
    await scope.fiber.await()
    const next = vi.fn(() => Promise.resolve<'unavailable'>('unavailable'))
    const result = bench.listener.call(scope.ctx, { toolName: 'bash' }, next)
    expect(bench.pending.getSnapshot()).toHaveLength(1)

    await bench.releasePending()

    await expect(result).resolves.toBe('unavailable')
    expect(next).toHaveBeenCalledOnce()
    expect(bench.pending.getSnapshot()).toEqual([])
    await scope.fiber.dispose()
  })

  it('publishes a scoped request without optional request metadata', async () => {
    const bench = await setupPlugin()
    const scope = createScope(bench.ctx, id('s1'))
    await scope.fiber.await()
    const result = bench.listener.call(scope.ctx, { toolName: 'read' }, () => Promise.resolve('unavailable'))
    const pending = bench.pending.getSnapshot()[0]!

    await pending.answer('rejected')

    await expect(result).resolves.toBe('rejected')
    expect(pending).toMatchObject({ toolName: 'read' })
    expect(pending.callId).toBeUndefined()
    expect(pending.reason).toBeUndefined()
    await scope.fiber.dispose()
  })

  it('removes stable registrations with the plugin lifetime', async () => {
    const bench = await setupPlugin()
    await bench.ctx.fiber.dispose()
    expect(bench.disposeSlot).toHaveBeenCalledOnce()
    expect(bench.disposeLocale).toHaveBeenCalledOnce()
  })
})

function panelProps(
  pending: PendingApproval,
  renderSlot: ApprovalComposerProps['renderSlot'] = vi.fn(() => null),
): ApprovalComposerProps {
  const messages: Record<string, string> = {
    waiting: 'Waiting',
    'detail.aria': 'Approval details',
    escalation: `Tool ${pending.toolName} asks`,
    reject: 'Reject',
    allowOnce: 'Allow once',
  }
  return {
    matched: pending,
    renderSlot,
    resolveReason: (reason: NonNullable<PendingApproval['displayReason']>) => reason.en,
    t: (key: string) => messages[key] ?? key,
  } as ApprovalComposerProps
}

describe('ApprovalPanel', () => {
  it('renders fallback copy without detail and returns rejection', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'bash' })
    const props = panelProps(pending)
    render(<ApprovalPanel {...props} />)

    expect(screen.getByText('Tool bash asks')).toBeTruthy()
    expect(document.querySelector('[data-approval-key] [data-state="warning"]')).not.toBeNull()
    expect(screen.getByRole('group', { name: 'Approval details' })).toBeTruthy()
    expect(props.renderSlot).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))

    expect(document.querySelector('[data-approval-key]')?.getAttribute('aria-busy')).toBe('true')
    await expect(pending.result).resolves.toBe('rejected')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reject' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(true)
  })

  it('renders correlated detail and returns allow-once', async () => {
    const pending = new PendingApproval(id('s1'), {
      toolName: 'bash',
      callId: 'call-1' as ToolCallId,
      reason: 'Run this exact command',
    })
    const renderSlot = vi.fn(() => <code>pnpm test</code>)
    render(<ApprovalPanel {...panelProps(pending, renderSlot)} />)

    expect(screen.getByText('Run this exact command')).toBeTruthy()
    expect(screen.getByText('pnpm test')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('conversation.approval.detail', {
      callId: 'call-1',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(document.querySelector('[data-approval-key] [data-state="ongoing"]')).not.toBeNull()
    expect(document.querySelector('[data-approval-key]')?.getAttribute('aria-busy')).toBe('true')

    await expect(pending.result).resolves.toBe('allowed-once')
  })

  it('keeps the audit reason intact and follows the UI language for presentation copy', () => {
    const pending = new PendingApproval(id('s1'), {
      toolName: 'bash',
      reason: 'audit reason',
      displayReason: { en: 'English explanation', zh: '中文说明' },
    })
    const props = panelProps(pending)
    const view = render(<ApprovalPanel {...props} />)
    expect(screen.getByText('English explanation')).toBeTruthy()
    expect(screen.queryByText('audit reason')).toBeNull()
    view.rerender(<ApprovalPanel {...props} resolveReason={reason => reason['zh']!} />)
    expect(screen.getByText('中文说明')).toBeTruthy()
    expect(pending.reason).toBe('audit reason')
  })

  it.each([['Enter', 'allowed-once'], ['Escape', 'rejected']] as const)(
    'answers the focused container with %s through the pending request', async (key, outcome) => {
      const pending = new PendingApproval(id('s1'), { toolName: 'bash' })
      render(<ApprovalPanel {...panelProps(pending)} />)
      const group = screen.getByRole('group', { name: 'Approval details' })
      group.focus()
      const bubbled = vi.fn()
      window.addEventListener('keydown', bubbled)
      try {
        fireEvent.keyDown(group, { key, code: key })
        await expect(pending.result).resolves.toBe(outcome)
        expect(bubbled).not.toHaveBeenCalled()
        expect(pending.answerable).toBe(false)
      } finally { window.removeEventListener('keydown', bubbled) }
    },
  )

  it('leaves button Enter to its native click and rejects from the reject button', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'bash' })
    render(<ApprovalPanel {...panelProps(pending)} />)
    const reject = screen.getByRole('button', { name: 'Reject' })
    reject.focus()
    expect(fireEvent.keyDown(reject, { key: 'Enter', code: 'Enter' })).toBe(true)
    expect(pending.answerable).toBe(true)
    // jsdom does not synthesize the browser's native button activation.
    fireEvent.click(reject)
    await expect(pending.result).resolves.toBe('rejected')
  })

  it('ignores unowned input, modified keys, repeats and IME candidate keys', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'bash', callId: 'call-1' as ToolCallId })
    const renderSlot = () => <input aria-label="Approval input" />
    render(<ApprovalPanel {...panelProps(pending, renderSlot)} />)
    const group = screen.getByRole('group', { name: 'Approval details' })
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    expect(pending.answerable).toBe(true)
    const input = screen.getByRole('textbox', { name: 'Approval input' })
    input.focus()
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' })
    group.focus()
    expect(fireEvent.keyDown(group, { key: 'Tab', code: 'Tab' })).toBe(true)
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter', ctrlKey: true })
    fireEvent.keyDown(group, { key: 'Escape', code: 'Escape', repeat: true })
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter', isComposing: true })
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter', keyCode: 229 })
    fireEvent.compositionStart(group)
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    fireEvent.compositionEnd(group)
    fireEvent.keyDown(group, { key: 'Escape', code: 'Escape' })
    expect(pending.answerable).toBe(true)
    fireEvent.keyUp(group, { key: 'Escape', code: 'Escape' })
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    await expect(pending.result).resolves.toBe('allowed-once')
  })

  it('locks keyboard and click submissions synchronously while the answer is pending', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'bash' })
    const gate = Promise.withResolvers<undefined>()
    const answer = vi.spyOn(pending, 'answer').mockImplementation(() => gate.promise)
    render(<ApprovalPanel {...panelProps(pending)} />)
    const group = screen.getByRole('group', { name: 'Approval details' })
    group.focus()
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(group, { key: 'Escape', code: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(answer).toHaveBeenCalledExactlyOnceWith('allowed-once')
    await act(async () => { gate.resolve(undefined); await gate.promise })
    pending.abort(new Error('test cleanup'))
    await pending.result.catch(() => {})
  })

  it('does not settle an aborted request or let its late rejection unlock its replacement', async () => {
    const first = new PendingApproval(id('s1'), { toolName: 'bash' })
    const gate = Promise.withResolvers<undefined>()
    vi.spyOn(first, 'answer').mockImplementation(() => gate.promise)
    const view = render(<ApprovalPanel {...panelProps(first)} />)
    let group = screen.getByRole('group', { name: 'Approval details' })
    group.focus()
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    first.abort(new Error('request withdrawn'))
    await first.result.catch(() => {})
    const second = new PendingApproval(id('s1'), { toolName: 'read' })
    view.rerender(<ApprovalPanel {...panelProps(second)} />)
    await act(async () => { gate.reject(new Error('late transport failure')); await gate.promise.catch(() => {}) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reject' }).disabled).toBe(false)
    second.abort(new Error('request withdrawn'))
    await second.result.catch(() => {})
    const answer = vi.spyOn(second, 'answer')
    group = screen.getByRole('group', { name: 'Approval details' })
    group.focus()
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(answer).not.toHaveBeenCalled()
  })

  it('re-enables actions when answering fails', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'bash' })
    vi.spyOn(pending, 'answer').mockRejectedValue(new Error('transport closed'))
    render(<ApprovalPanel {...panelProps(pending)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(true)
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(false)
    })
    expect(document.querySelector('[data-approval-key]')?.getAttribute('aria-busy')).toBe('false')
    pending.abort(new Error('test cleanup'))
    await pending.result.catch(() => {})
  })
})

describe('package entries', () => {
  it('declares its service edges and keeps the Host half inert', () => {
    expect(inject).toEqual(['sessions', 'remote', 'uiSession', 'slots', 'locale'])
    expect(() => { nodeApply() }).not.toThrow()
  })
})
