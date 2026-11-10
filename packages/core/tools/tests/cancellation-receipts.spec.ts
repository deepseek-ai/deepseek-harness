/** Receipt-bearing tool success and cancellation across the real execution pipeline. */

import { Context } from '@deepseek-ai/cordis'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { defineTool, TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

async function fixture() {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    return {
      ctx,
      run(signal: AbortSignal) {
        return executeToolFixture(ctx, {
          callId: ToolCallId('receipt-call'), name: 'receipt', arguments: {}, signal,
        })
      },
      async [Symbol.asyncDispose]() { await ctx.fiber.dispose() },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

function receiptTool(preserveSuccessOnCancellation: boolean | undefined, body: () => Promise<string> = async () => 'accepted') {
  return defineTool({
    name: 'receipt',
    description: 'Accept one operation and return its receipt.',
    parameters: {},
    ...preserveSuccessOnCancellation === undefined ? {} : { preserveSuccessOnCancellation },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: body,
  })
}

describe('tool success receipts after cancellation', () => {
  it.each([undefined, false, true])('keeps the %s cancellation policy out of model-facing schemas', async (preserve) => {
    await using f = await fixture()
    f.ctx.tools.register(receiptTool(preserve))
    expect(f.ctx.tools.get('receipt')?.preserveSuccessOnCancellation).toBe(preserve)
    expect(f.ctx.tools.schemas()).toHaveLength(1)
    expect(f.ctx.tools.schemas()[0]).not.toHaveProperty('preserveSuccessOnCancellation')
  })

  it.each([undefined, false, true])('keeps successful body results only when opted in: %s', async (preserve) => {
    await using f = await fixture()
    const cancellation = new AbortController()
    f.ctx.tools.register(receiptTool(preserve, async () => {
      cancellation.abort('cancelled after acceptance')
      return 'accepted'
    }))

    const result = await f.run(cancellation.signal)
    if (preserve) {
      expect(result).toEqual({ value: 'accepted', content: [{ type: 'text', text: 'accepted' }], isError: false })
    } else {
      expect(result).toMatchObject({ isError: true, error: { info: { name: 'AbortError', code: TOOL_ABORTED } } })
      expect(result).not.toHaveProperty('value')
    }
  })

  it.each(['wrapper', 'post-execute'] as const)('retains an accepted receipt while %s settles after cancellation', async (phase) => {
    await using f = await fixture()
    const cancellation = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    f.ctx.tools.register(receiptTool(true))
    if (phase === 'wrapper') {
      f.ctx.on('tools/execute', async (_exec, next) => {
        const result = await next()
        entered.resolve(undefined)
        await release.promise
        return result
      })
    } else {
      f.ctx.on('tools/post-execute', async (_exec, _result, next) => {
        const decision = await next()
        entered.resolve(undefined)
        await release.promise
        return decision
      })
    }
    const pending = f.run(cancellation.signal)
    try {
      await entered.promise
      cancellation.abort('cancelled after body acceptance')
      release.resolve(undefined)
      await expect(pending).resolves.toEqual({ value: 'accepted', content: [{ type: 'text', text: 'accepted' }], isError: false })
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([pending])
    }
  })

  it.each([false, true])('uses the definition captured before policy even when it changes: %s', async (captured) => {
    await using f = await fixture()
    const cancellation = new AbortController()
    let preserve = captured
    f.ctx.tools.register({
      ...receiptTool(captured, async () => {
        cancellation.abort('cancelled after acceptance')
        return 'accepted'
      }),
      get preserveSuccessOnCancellation() { return preserve },
    })
    f.ctx.on('tools/pre-execute', async (_exec, next) => {
      preserve = !captured
      return next()
    })

    const result = await f.run(cancellation.signal)
    expect(result.isError).toBe(!captured)
    if (captured) expect(result.value).toBe('accepted')
    else expect(result.error?.info?.code).toBe(TOOL_ABORTED)
  })

  it.each(['before-prepare', 'pre-execute', 'wrapper'] as const)('never dispatches opted-in tools cancelled during %s', async (phase) => {
    await using f = await fixture()
    const cancellation = new AbortController()
    let dispatched = 0
    f.ctx.tools.register(receiptTool(true, async () => { dispatched++; return 'accepted' }))
    if (phase === 'before-prepare') cancellation.abort('cancelled before preparation')
    else if (phase === 'pre-execute') {
      f.ctx.on('tools/pre-execute', async (_exec, next) => {
        cancellation.abort('cancelled before dispatch')
        return next()
      })
    } else {
      f.ctx.on('tools/execute', async (_exec, next) => {
        cancellation.abort('cancelled before body invocation')
        return next()
      })
    }

    await expect(f.run(cancellation.signal)).resolves.toMatchObject({
      isError: true, error: { info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } },
    })
    expect(dispatched).toBe(0)
  })

  it('does not preserve a wrapper success when the body never ran', async () => {
    await using f = await fixture()
    const cancellation = new AbortController()
    let dispatched = 0
    f.ctx.tools.register(receiptTool(true, async () => { dispatched++; return 'accepted' }))
    f.ctx.on('tools/execute', async () => {
      cancellation.abort('cancelled before body invocation')
      return { value: 'wrapper result', content: [{ type: 'text', text: 'wrapper result' }], isError: false }
    })

    await expect(f.run(cancellation.signal)).resolves.toMatchObject({
      isError: true, error: { info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } },
    })
    expect(dispatched).toBe(0)
  })

  it.each(['pre-deny', 'wrapper-failure', 'post-block', 'post-failure'] as const)('keeps %s authoritative after cancellation', async (policy) => {
    await using f = await fixture()
    const cancellation = new AbortController()
    let dispatched = 0
    f.ctx.tools.register(receiptTool(true, async () => { dispatched++; return 'accepted' }))
    if (policy === 'pre-deny') {
      f.ctx.on('tools/pre-execute', async () => {
        cancellation.abort('cancelled while policy decides')
        return { kind: 'deny', reason: 'operation denied', info: { name: 'ReceiptPolicyError', code: 'RECEIPT_DENIED' } }
      })
    } else if (policy === 'wrapper-failure') {
      f.ctx.on('tools/execute', async () => {
        cancellation.abort('cancelled while wrapper fails')
        throw new HarnessError('wrapper failed', 'RECEIPT_DENIED')
      })
    } else if (policy === 'post-block') {
      f.ctx.on('tools/post-execute', async () => {
        cancellation.abort('cancelled while post-policy blocks')
        return {
          kind: 'block', feedback: [{ type: 'text', text: 'operation blocked' }],
          info: { name: 'ReceiptPolicyError', code: 'RECEIPT_DENIED' },
        }
      })
    } else {
      f.ctx.on('tools/post-execute', async () => {
        cancellation.abort('cancelled while post-policy fails')
        throw new HarnessError('post-policy failed', 'RECEIPT_DENIED')
      })
    }

    const result = await f.run(cancellation.signal)
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'RECEIPT_DENIED' } } })
    expect(result).not.toHaveProperty('value')
    expect(dispatched).toBe(policy === 'post-block' || policy === 'post-failure' ? 1 : 0)
  })

  it('keeps the tool-owned failure when an opted-in body rejects after cancellation', async () => {
    await using f = await fixture()
    const cancellation = new AbortController()
    f.ctx.tools.register(receiptTool(true, async () => {
      cancellation.abort('cancelled before acceptance')
      throw new HarnessError('operation did not accept input', 'RECEIPT_REJECTED')
    }))

    await expect(f.run(cancellation.signal)).resolves.toMatchObject({
      isError: true, error: { info: { name: 'HarnessError', code: 'RECEIPT_REJECTED' } },
    })
  })
})
