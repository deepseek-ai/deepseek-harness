/** A request the account route authenticated ends with the sign-out of its credential and ends the route's running tasks. */
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { accountStub } from '../../../account/deepseek-account/tests/account-stub.ts'
import * as Account from '../src/index.ts'
import DeepSeekAuth from '@deepseek-ai/dsh-deepseek-auth'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

const SIGNED_OUT_CANCEL = [{ kind: 'hook', reason: 'deepseek-account/signed-out' }, { keepInbox: true }]
const SIGNED_OUT_FAILURE = {
  code: 'ACCOUNT_SIGN_IN_REQUIRED',
  message: 'The DeepSeek account signed out before this request finished. Sign in to DeepSeek to use the account provider.',
}

/**
 * Mount the runtime, an account whose sign-out the test drives, a registry holding one running account task and one
 * running API-key task, and the account route.
 * @param options.reject - observes a rejected token, as the account service does before it signs out.
 * @param options.agents - false mounts no Agent registry, as a composition without Agents does.
 */
async function route(options: { reject?: (token: string) => void; agents?: boolean } = {}) {
  const { reject } = options
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const signedOut = new AbortController()
  const cancelAccountTask = vi.fn()
  const cancelApiKeyTask = vi.fn()
  if (options.agents !== false) {
    ctx.provide('agents', { list: () => [
      { status: 'running', session: { requestContext: () => ({ provider: 'deepseek-account' }) }, cancel: cancelAccountTask },
      { status: 'running', session: { requestContext: () => ({ provider: 'deepseek-official' }) }, cancel: cancelApiKeyTask },
    ] } as never)
  }
  // The route registers its running-task report once Agents and the account service are both mounted.
  ctx.provide('deepseekAccount', Object.assign(
    accountStub({ token: () => 'account-token', signedOut: signedOut.signal, ...reject === undefined ? {} : { reject } }),
    { registerRunningTaskReport: () => () => {} },
  ))
  await ctx.plugin(DeepSeekAuth)
  const plugin = ctx.plugin(Account)
  await plugin
  return { ctx, signedOut, cancelAccountTask, cancelApiKeyTask, plugin }
}

/** Answer the Messages request through `messages`; the model listing fails fast, so the route serves its bundled catalog. */
function upstream(messages: (signal: AbortSignal) => Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    return url.pathname === '/models' ? Promise.resolve(new Response(null, { status: 404 })) : messages(init!.signal!)
  })
}

/** Hold the Messages request open until its signal aborts, as an open provider response does. */
function heldUpstream() {
  const sent = Promise.withResolvers<AbortSignal>()
  upstream((signal) => {
    sent.resolve(signal)
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
    })
  })
  return sent.promise
}

/** Drive one streamed request through the runtime and return its terminal outcome. */
async function finishOf(ctx: Context) {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider: 'deepseek-account', model: 'deepseek-flash', messages: [] })) assembler.push(chunk)
  return assembler.finish
}

it.each([
  { route: 'mounted', unload: false },
  { route: 'unloaded', unload: true },
])('ends an open request and the running account tasks when its credential is signed out while the route is $route', async ({ unload }) => {
  const { ctx, signedOut, cancelAccountTask, cancelApiKeyTask, plugin } = await route()
  const sent = heldUpstream()
  const finish = finishOf(ctx)
  const request = await sent
  if (unload) await plugin.dispose()
  expect(request.aborted).toBe(false)
  // The account service runs the sign-out listeners first; an unloaded route has none left.
  ctx.emit('deepseek-account/signed-out')
  expect(cancelAccountTask.mock.calls).toEqual(unload ? [] : [SIGNED_OUT_CANCEL])
  signedOut.abort()
  expect(request.aborted).toBe(true)
  await expect(finish).resolves.toMatchObject({ kind: 'error', failure: SIGNED_OUT_FAILURE })
  // The request that carried the signed-out token ends the tasks itself; a task cancelled twice keeps its first cause.
  expect(cancelAccountTask.mock.calls).toEqual(unload ? [SIGNED_OUT_CANCEL] : [SIGNED_OUT_CANCEL, SIGNED_OUT_CANCEL])
  expect(cancelApiKeyTask).not.toHaveBeenCalled()
})

it('ends an open request at sign-out in a composition without Agents, which has no task to end', async () => {
  const { ctx, signedOut } = await route({ agents: false })
  const sent = heldUpstream()
  const finish = finishOf(ctx)
  const request = await sent
  signedOut.abort()
  await expect(finish).resolves.toMatchObject({ kind: 'error', failure: SIGNED_OUT_FAILURE })
  expect(request.aborted).toBe(true)
})

it('does not send a request whose credential was signed out before dispatch', async () => {
  const { ctx, signedOut, cancelAccountTask } = await route()
  const messages = vi.fn(() => Promise.resolve(new Response(null, { status: 500 })))
  upstream(messages)
  signedOut.abort()
  await expect(finishOf(ctx)).resolves.toMatchObject({ kind: 'error', failure: SIGNED_OUT_FAILURE })
  expect(messages).not.toHaveBeenCalled()
  expect(cancelAccountTask.mock.calls).toEqual([SIGNED_OUT_CANCEL])
})

it('reports a provider failure that arrives after the sign-out as the sign-out, without rejecting the token', async () => {
  const rejectToken = vi.fn()
  const { ctx, signedOut, cancelAccountTask } = await route({ reject: rejectToken })
  upstream(() => {
    signedOut.abort()
    return Promise.resolve(new Response('Unauthorized', { status: 401 }))
  })
  await expect(finishOf(ctx)).resolves.toMatchObject({ kind: 'error', failure: SIGNED_OUT_FAILURE })
  expect(rejectToken).not.toHaveBeenCalled()
  expect(cancelAccountTask.mock.calls).toEqual([SIGNED_OUT_CANCEL])
})

it('ends the running account tasks when the rejection of its token signs the account out', async () => {
  const signOut: Array<() => void> = []
  const { ctx, signedOut, cancelAccountTask, cancelApiKeyTask } = await route({ reject: () => { for (const run of signOut) run() } })
  signOut.push(() => { signedOut.abort() })
  upstream(() => Promise.resolve(new Response('Unauthorized', { status: 401 })))
  await expect(finishOf(ctx)).resolves.toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_TOKEN_INVALID' } })
  expect(cancelAccountTask.mock.calls).toEqual([SIGNED_OUT_CANCEL])
  expect(cancelApiKeyTask).not.toHaveBeenCalled()
})

it.each([
  { failure: 'a provider error', status: 500, code: 'SERVER' },
  { failure: 'a rejected token whose removal did not sign out', status: 401, code: 'ACCOUNT_TOKEN_INVALID' },
])('leaves running tasks alone after $failure while the account stays signed in', async ({ status, code }) => {
  const { ctx, cancelAccountTask } = await route()
  upstream(() => Promise.resolve(new Response('failed', { status })))
  await expect(finishOf(ctx)).resolves.toMatchObject({ kind: 'error', failure: { code } })
  expect(cancelAccountTask).not.toHaveBeenCalled()
})
