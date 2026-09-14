/** Provider unload owns screenshot admission as well as the native call. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import * as NativeProvider from '../src/index.ts'
import { fixture, resetFixture } from './fixtures/cua-driver.ts'

vi.mock('@trycua/cua-driver', async () => import('./fixtures/cua-driver.ts'))

let ctx: Context
let root: string | undefined

beforeEach(async () => {
  resetFixture()
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ComputerUseRegistry)
  root = await mkdtemp(join(tmpdir(), 'dsh-native-cancellation-'))
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('aborts model admission on unload, restores caller cancellation, and closes the native runtime', async () => {
  const resolving = Promise.withResolvers<AbortSignal>()
  const resolved = Promise.withResolvers<LlmResolvedModelInfo>()
  class BlockingModel extends LlmAdapter {
    override resolveModel(_provider: string, _model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
      if (signal === undefined) throw new Error('Image admission must provide cancellation')
      signal.throwIfAborted()
      const abort = () => { resolved.reject(new Error('Model admission canceled')) }
      signal.addEventListener('abort', abort, { once: true })
      resolving.resolve(signal)
      return resolved.promise.finally(() => { signal.removeEventListener('abort', abort) })
    }

    stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      throw new Error('This fixture only resolves image capabilities')
    }
  }
  ctx.llm.registerAdapter(['visual'], new BlockingModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('native-admission'), { provider: 'visual', model: 'vision' })
  const fiber = ctx.plugin(NativeProvider)
  await fiber
  let dispatch: ToolExecution | undefined
  ctx.on('tools/pre-execute', async (exec, next) => {
    dispatch = exec
    return next()
  })
  const controller = new AbortController()
  const result = ctx.tools.execute({
    agent, signal: controller.signal, callId: ToolCallId('native-admission'),
    name: 'cua_driver_native__get_window_state', arguments: { pid: 9, window_id: 7 },
  })
  const admissionSignal = await resolving.promise
  const disposal = fiber.dispose()
  try {
    await vi.waitFor(() => { expect(admissionSignal.aborted).toBe(true) })
    await disposal
    expect((await result).isError).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    expect(dispatch?.signal).toBe(controller.signal)
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
    expect(fixture.shutdowns).toBe(1)
    expect(fixture.destroys).toBe(1)
  } finally {
    resolved.reject(new Error('Test cleanup'))
    await result
    await disposal
  }
})
