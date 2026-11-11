/** Held-key cleanup through real native byte streams and the tool execution wrapper. */
import { PassThrough, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { Context } from '@deepseek-ai/cordis'
import { NativeClient } from '@deepseek-ai/dsh-cua/native-client'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { installHeldKeys } from '../src/held-keys.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const Request = z.object({ id: z.string(), method: z.string(), params: z.record(z.string(), z.json()) })

function nativeConnection(holdRelease = false) {
  const requests: z.infer<typeof Request>[] = []
  const events: string[] = []
  const held = new Set<string>()
  const releasing: PromiseWithResolvers<void> = Promise.withResolvers()
  const stdout = new PassThrough()
  let releaseId: string | undefined
  const acknowledge = (): void => {
    if (releaseId === undefined) return
    held.clear()
    events.push('released')
    stdout.write(JSON.stringify({ id: releaseId, result: { dispatched: true } }) + '\n')
    releaseId = undefined
  }
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = Request.parse(JSON.parse(String(chunk)))
    requests.push(request)
    if (request.method === 'releaseHeldKeys') {
      events.push('release requested')
      releaseId = request.id
      releasing.resolve()
      if (!holdRelease) acknowledge()
    } else {
      held.add(z.string().parse(request.params.key))
      events.push('key held')
      stdout.write(JSON.stringify({ id: request.id, result: { dispatched: true } }) + '\n')
    }
    callback()
  } })
  const done = Promise.all([finished(stdin, { cleanup: true }), finished(stdout, { cleanup: true })]).then(() => undefined)
  const close = vi.fn(() => {
    events.push('connection closed')
    held.clear()
    stdin.end()
    stdout.end()
  })
  const client = new NativeClient({ subprocess: { spawn() { throw new Error('The byte-stream fixture does not spawn a helper') } } }, {
    helperPath: '/fixture/helper', cwd: '/fixture', timeoutMs: 60_000, connectTimeoutMs: 5000,
    screenshotTimeoutMs: 5000, axTimeoutMs: 3000, maxRequestBytes: 4096, maxResponseBytes: 4096,
    graceMs: 1000, textEventIntervalMs: 1, maxClickHoldMs: 5000,
  }, () => ({ stdin, stdout, done, close, waitForClose: () => done }))
  onTestFinished(async () => { client.invalidate(); await client.dispose().catch(() => undefined) })
  return { client, requests, events, held, releasing: releasing.promise, acknowledge, close }
}

async function program(body: (send: (client: NativeClient) => Promise<void>) => Promise<void>) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const sendKeyEvent = installHeldKeys(ctx)
  ctx.tools.register(defineTool({ name: 'cua_run_code', description: 'Exercise native key ownership.', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] },
    async execute(_args, execution) {
      await body(async (client) => {
        await sendKeyEvent(client, { key: 'w', direction: 'down' }, {
          ...execution, name: 'cua', callId: brandString<ToolCallId>('held-key'), parent: execution.token,
        })
      })
      return null
    },
  }))
  return { run: () => executeToolFixture(ctx, { name: 'cua_run_code', callId: brandString<ToolCallId>('held-program'), arguments: {}, signal: new AbortController().signal }) }
}

it('releases native keys before connection closure without waiting for unrelated program work', async () => {
  const native = nativeConnection(true)
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const finishProgram: PromiseWithResolvers<void> = Promise.withResolvers()
  const fixture = await program(async (send) => {
    await send(native.client)
    entered.resolve()
    await finishProgram.promise
  })
  let programEnded = false
  const running = fixture.run().then((result) => { programEnded = true; return result })
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = native.client.dispose()
    await native.releasing
    expect(native.held).toEqual(new Set(['w']))
    expect(native.close).not.toHaveBeenCalled()
    native.acknowledge()
    await closing
    expect(programEnded).toBe(false)
    expect(native.events).toEqual(['key held', 'release requested', 'released', 'connection closed'])
    expect(native.held.size).toBe(0)
    finishProgram.resolve()
    expect((await running).isError).toBe(false)
    expect(native.requests.map(request => request.method)).toEqual(['sendKeyEvent', 'releaseHeldKeys'])
    expect(native.close).toHaveBeenCalledTimes(1)
  } finally {
    finishProgram.resolve()
    native.acknowledge()
    await running
    await closing
  }
})

it('cleans up local held-key ownership after forced connection closure without sending another request', async () => {
  const native = nativeConnection()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const finishProgram: PromiseWithResolvers<void> = Promise.withResolvers()
  const fixture = await program(async (send) => {
    await send(native.client)
    entered.resolve()
    await finishProgram.promise
    await expect(send(native.client)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
  const running = fixture.run()
  try {
    await entered.promise
    native.client.invalidate()
    await native.client.dispose()
    expect(native.held.size).toBe(0)
    finishProgram.resolve()
    expect((await running).isError).toBe(false)
    expect(native.requests.map(request => request.method)).toEqual(['sendKeyEvent'])
    expect(native.close).toHaveBeenCalledTimes(1)
  } finally { finishProgram.resolve(); await running }
})

it('keeps a held-key run on its first connection and unregisters after normal release', async () => {
  const first = nativeConnection()
  const second = nativeConnection()
  const register = vi.spyOn(second.client, 'registerCleanup')
  onTestFinished(() => { register.mockRestore() })
  const fixture = await program(async (send) => {
    await send(first.client)
    await expect(send(second.client)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
  expect((await fixture.run()).isError).toBe(false)
  expect(register).not.toHaveBeenCalled()
  expect(second.requests).toEqual([])
  expect(first.requests.map(request => request.method)).toEqual(['sendKeyEvent', 'releaseHeldKeys'])
  await first.client.dispose()
  expect(first.requests).toHaveLength(2)
  expect(first.close).toHaveBeenCalledTimes(1)
})
