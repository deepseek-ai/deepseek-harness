import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { ScriptedAdapter, type ScriptedCall } from './scripted-adapter.ts'

const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** One complete text response. */
function textChunks(value: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One complete single-tool-call response, ending the model turn. */
function toolCallChunks(callId: string, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(callId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function setup(build?: (id: JobId) => ScriptedCall[]) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  // The job's id is opaque, and the scripted model call must name it, so the
  // script is appended once the registry has issued it.
  const adapter = new ScriptedAdapter([])
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('steer-wait'), agentOptions: { provider: 'mock', model: 'mock' } })
  const agent = handle.agent
  const done = Promise.withResolvers<JobOutcome>()
  const cancel = vi.fn(() => { done.resolve({ status: 'killed' }) })
  const id = ctx.jobs.start({ kind: 'bash', label: 'gated producer', owner: agent.id, run(job) {
    job.append('ready output\n')
    return { done: done.promise, cancel }
  } })
  adapter.push(...build?.(id) ?? [
    toolCallChunks('wait', 'job_output', { job_id: id, wait: true, timeout_ms: 600_000 }),
    textChunks('input handled'),
  ])
  const registered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const originalWait = ctx.jobs.wait.bind(ctx.jobs)
  vi.spyOn(ctx.jobs, 'wait').mockImplementation((...args) => {
    const pending = originalWait(...args)
    // LocalJobRegistry registers synchronously before returning this promise.
    registered.resolve(undefined)
    void pending.then(() => { released.resolve(undefined) }, () => { released.resolve(undefined) })
    return pending
  })
  return { ctx, agent, adapter, id, done, cancel, registered, released, async dispose() {
    done.resolve({ status: 'completed' })
    agent.cancel({ kind: 'user' })
    await handle.dispose()
    await ctx.fiber.dispose()
  } }
}

describe('next-step input during a background result wait', () => {
  it('releases a registered wait before producer settlement and admits steering after step end', async () => {
    const h = await setup()
    try {
      h.agent.followup(message('start'))
      await h.registered.promise
      expect(h.ctx.jobs.get(h.id, h.agent.id).status).toBe('running')
      expect(h.adapter.requests).toHaveLength(1)
      const steer = message('UNIQUE_STEER_5965')
      h.agent.steer(steer)
      let released = false
      void h.released.promise.then(() => { released = true })
      await setImmediate()
      expect(released).toBe(true)
      await h.agent.whenIdle()
      expect(h.ctx.jobs.get(h.id, h.agent.id).status).toBe('running')
      expect(h.cancel).not.toHaveBeenCalled()
      expect(h.adapter.requests).toHaveLength(2)
      expect(JSON.stringify(h.adapter.requests[1]?.messages)).toContain('UNIQUE_STEER_5965')
      expect(JSON.stringify(h.adapter.requests[1]?.messages)).toContain('ready output\\n[status: running, user steered]')
      const events = h.agent.session.snapshotEvents()
      const receipt = events.find(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.id === steer.id))!
      const result = events.find(e => e.type === 'tool/result')!
      const end = events.find(e => e.type === 'step/end')!
      const admitted = events.find(e => e.type === 'user/message' && e.data.id === steer.id)!
      expect(receipt.seq).toBeLessThan(result.seq)
      expect(result.seq).toBeLessThan(end.seq)
      expect(end.seq).toBeLessThan(admitted.seq)
      expect(events.filter(e => e.type === 'turn/start')).toHaveLength(1)
      h.done.resolve({ status: 'completed', result: 'final output' })
      const settled = Promise.withResolvers<undefined>()
      const unsubscribe = h.ctx.jobs.events.subscribe({ owner: h.agent.id }, (event) => {
        if (event.type === 'settled') { expect(event.awaited).toBe(false); settled.resolve(undefined) }
      })
      await settled.promise
      unsubscribe()
      // The settlement's notice carries the result inline, so the registry has nothing left to hand out.
      expect(h.agent.inbox.nextStep).toHaveLength(1)
      expect(JSON.stringify(h.agent.inbox.nextStep[0]!.content)).toContain('Output:\\nfinal output')
      expect(h.ctx.jobs.read(h.id, h.agent.id).result).toBeUndefined()
    } finally { await h.dispose() }
  })

  it('does not release a wait for next-turn queue input', async () => {
    const h = await setup(id => [
      toolCallChunks('wait', 'job_output', { job_id: id, wait: true }),
      textChunks('original done'), textChunks('queued handled'),
    ])
    try {
      h.agent.followup(message('start'))
      await h.registered.promise
      h.agent.followup(message('UNIQUE_QUEUE_5965'))
      let released = false
      void h.released.promise.then(() => { released = true })
      await setImmediate()
      expect(released).toBe(false)
      expect(h.adapter.requests).toHaveLength(1)
      h.done.resolve({ status: 'completed' })
      await h.agent.whenIdle()
      expect(JSON.stringify(h.adapter.requests[1]?.messages)).not.toContain('UNIQUE_QUEUE_5965')
      expect(JSON.stringify(h.adapter.requests[2]?.messages)).toContain('UNIQUE_QUEUE_5965')
      expect(h.agent.session.snapshotEvents().filter(e => e.type === 'turn/start')).toHaveLength(2)
      expect(h.cancel).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('releases for already-pending input without waiting for another insertion', async () => {
    const h = await setup()
    try {
      h.agent.inbox.append('next-step', message('ALREADY_PENDING'))
      const result = await executeToolFixture(h.ctx, { name: 'job_output', callId: ToolCallId('pending'), arguments: { job_id: h.id, wait: true }, agent: h.agent, signal: new AbortController().signal })
      expect(result.isError).not.toBe(true)
      expect(JSON.stringify(result.content)).toContain('[status: running, user steered]')
      expect(h.agent.inbox.nextStep).toHaveLength(1)
      expect(h.cancel).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('does not lose input inserted during waiter registration', async () => {
    const h = await setup()
    try {
      const waitSpy = vi.spyOn(h.ctx.jobs, 'wait')
      const originalWait = waitSpy.getMockImplementation()!
      waitSpy.mockImplementation((...args) => {
        h.agent.inbox.append('next-step', message('REGISTRATION_RACE'))
        return originalWait(...args)
      })
      const result = await executeToolFixture(h.ctx, { name: 'job_output', callId: ToolCallId('race'), arguments: { job_id: h.id, wait: true }, agent: h.agent, signal: new AbortController().signal })
      expect(result.isError).not.toBe(true)
      expect(JSON.stringify(result.content)).toContain('[status: running, user steered]')
      expect(h.cancel).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('releases both parallel waits but drains ordinary work before admitting edited input', async () => {
    const h = await setup((id) => {
      const first = toolCallChunks('wait-a', 'job_output', { job_id: id, wait: true })
      const second = toolCallChunks('wait-b', 'job_output', { job_id: id, wait: true })
      const ordinary = toolCallChunks('ordinary', 'ordinary', {})
      const blocks = [first, second, ordinary].flatMap((chunks, index) => chunks.filter(chunk => chunk.type !== 'finish').map(chunk => 'index' in chunk ? { ...chunk, index } : chunk))
      return [[...blocks, { type: 'finish', reason: { kind: 'tool-calls' } }], textChunks('both inputs handled')]
    })
    const entered = Promise.withResolvers<AbortSignal>()
    const drain = Promise.withResolvers<undefined>()
    const bothRegistered = Promise.withResolvers<undefined>()
    const bothReleased = Promise.withResolvers<undefined>()
    try {
      const jobTool = h.ctx.tools.get('job_output')!
      h.agent.ctx.tools.register({ ...jobTool, isConcurrencySafe: () => true })
      h.ctx.tools.register(defineContentToolFixture({ name: 'ordinary', description: 'gated execution', parameters: {}, isConcurrencySafe: () => true, async execute(_args, exec) {
        entered.resolve(exec.signal)
        await drain.promise
        return [{ type: 'text', text: 'ordinary actual result' }]
      } }))
      const waitSpy = vi.spyOn(h.ctx.jobs, 'wait')
      const originalWait = waitSpy.getMockImplementation()!
      let registered = 0
      let released = 0
      waitSpy.mockImplementation((...args) => {
        const pending = originalWait(...args)
        if (++registered === 2) bothRegistered.resolve(undefined)
        // The tool's own controller ends a released wait as a cancellation, so
        // both outcomes count as released; only the tool swallows the reject.
        void pending.then(
          () => { if (++released === 2) bothReleased.resolve(undefined) },
          () => { if (++released === 2) bothReleased.resolve(undefined) },
        )
        return pending
      })
      h.agent.followup(message('start'))
      const signal = await entered.promise
      await bothRegistered.promise
      const removed = message('WITHDRAWN')
      const edited = message('ORIGINAL_EDIT')
      h.agent.steer(removed)
      h.agent.inbox.remove(removed.id)
      h.agent.steer(edited)
      const replacement = message('EDITED_INPUT')
      h.agent.inbox.replace(edited.id, replacement)
      h.agent.steer(message('SECOND_STEER'))
      expect(() => { h.agent.steer(replacement) }).toThrow('already pending')
      await bothReleased.promise
      expect(signal.aborted).toBe(false)
      expect(h.adapter.requests).toHaveLength(1)
      expect(h.ctx.jobs.get(h.id, h.agent.id).status).toBe('running')
      drain.resolve(undefined)
      await h.agent.whenIdle()
      const request = JSON.stringify(h.adapter.requests[1]?.messages)
      expect(request).toContain('ordinary actual result')
      expect(request).toContain('EDITED_INPUT')
      expect(request).toContain('SECOND_STEER')
      expect(request).not.toContain('WITHDRAWN')
      expect(request).not.toContain('ORIGINAL_EDIT')
      const events = h.agent.session.snapshotEvents()
      expect(events.filter(e => e.type === 'tool/result')).toHaveLength(3)
      expect(events.filter(e => e.type === 'user/message' && e.data.id === replacement.id)).toHaveLength(1)
      expect(h.cancel).not.toHaveBeenCalled()
    } finally { drain.resolve(undefined); await h.dispose() }
  })

  it('keeps explicit cancel separate and removes the input listener on wait exit', async () => {
    const h = await setup()
    try {
      h.agent.followup(message('start'))
      await h.registered.promise
      h.agent.cancel({ kind: 'user' })
      await h.agent.whenIdle()
      expect(h.ctx.jobs.get(h.id, h.agent.id).status).toBe('running')
      expect(h.agent.inbox.nextStep).toHaveLength(0)
      expect(h.cancel).not.toHaveBeenCalled()
      expect(JSON.stringify(h.agent.session.snapshotEvents())).toContain('wait aborted')
      // A queued input after the cancel must not reopen a claim on this job: a
      // leaked listener would open one here and suppress the notice below.
      h.agent.inbox.append('next-step', message('AFTER_CANCEL'))
      expect(h.ctx.jobs.get(h.id, h.agent.id).status).toBe('running')
      h.done.resolve({ status: 'completed' })
      await setImmediate()
      const notices = h.agent.inbox.nextStep.filter(m => m.source.kind === 'tool-jobs')
      expect(notices).toHaveLength(1)
      expect(JSON.stringify(notices[0])).toContain('finished')
    } finally { await h.dispose() }
  })
})
