/** Account cancellation follows logged routes and the owning plugin lifetime. */
import { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { installAccountTaskCancellation } from '../src/account-tasks.ts'

it('cancels running account tasks with their inboxes retained and detaches with its owner', async () => {
  const ctx = new Context()
  const cancelAccount = vi.fn()
  const cancelOther = vi.fn()
  const cancelIdle = vi.fn()
  const tasks = [
    { status: 'running', session: { requestContext: () => ({ provider: 'deepseek-account' }) }, cancel: cancelAccount },
    { status: 'running', session: { requestContext: () => ({ provider: 'deepseek-official' }) }, cancel: cancelOther },
    { status: 'idle', session: { requestContext: () => ({ provider: 'deepseek-account' }) }, cancel: cancelIdle },
    { status: 'running', session: { requestContext: () => undefined }, cancel: cancelOther },
  ]
  ctx.provide('agents', { list: () => tasks } as never)
  const owner = ctx.plugin((scope) => { installAccountTaskCancellation(scope) })
  try {
    await owner.await()
    ctx.emit('deepseek-account/signed-out')
    expect(cancelAccount).toHaveBeenCalledExactlyOnceWith(
      { kind: 'hook', reason: 'deepseek-account/signed-out' }, { keepInbox: true },
    )
    expect(cancelOther).not.toHaveBeenCalled()
    expect(cancelIdle).not.toHaveBeenCalled()
    const notice = vi.fn()
    ctx.on('deepseek-account/model-sign-in-required', notice)
    const report = (error: unknown) => { ctx.emit('agent/error', { agent: {} as never, turn: 0, step: 0, error }) }
    report(new Error('offline'))
    report(new LlmError('API key invalid', 'INVALID_API_KEY'))
    expect(notice).not.toHaveBeenCalled()
    report(new LlmError('Sign in required', 'ACCOUNT_SIGN_IN_REQUIRED'))
    expect(notice).toHaveBeenCalledTimes(1)
    await owner.dispose()
    report(new LlmError('Sign in required', 'ACCOUNT_SIGN_IN_REQUIRED'))
    expect(notice).toHaveBeenCalledTimes(1)
    ctx.emit('deepseek-account/signed-out')
    expect(cancelAccount).toHaveBeenCalledTimes(1)
  } finally { await ctx.fiber.dispose() }
})
