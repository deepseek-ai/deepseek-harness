import { execFile } from 'node:child_process'
import { setImmediate } from 'node:timers/promises'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished } from 'vitest'
import { runWorkflowGuest } from '../src/guest.ts'
import { WORKFLOW_GUEST_SOURCE } from '../src/guest-source.ts'
import type { WorkflowGuestHost, WorkflowProgress } from '../src/guest-types.ts'
import type { ChildResult, ChildStartRequest, WorkerInit, WorkerLimits } from '../src/types.ts'

function fixture(body: string, overrides: Partial<WorkflowGuestHost> = {}, limits: Partial<WorkerLimits> = {}) {
  const requests: ChildStartRequest[] = []
  const events: WorkflowProgress[] = []
  const disposed: number[] = []
  const init: WorkerInit = {
    meta: { name: 'guest-test', description: 'exercise workflow guest callbacks' },
    body,
    args: { prompt: 'answer this' },
    limits: { maxConcurrentAgents: 4, maxTotalAgents: 8, maxItemsPerCall: 8, syncTimeoutMs: 5000, ...limits },
  }
  const host: WorkflowGuestHost = {
    begin: async () => init,
    async startChild(request) {
      requests.push(request)
      return { callId: requests.length, childId: `child-${requests.length}` }
    },
    childResult: async ({ callId }) => ({ output: [{ type: 'text', text: requests[callId - 1]!.prompt }], stopReason: 'completed' }),
    async disposeChild({ callId }) { disposed.push(callId); return null },
    async progress(batch) { events.push(...batch); return null },
    ...overrides,
  }
  return { host, init, requests, events, disposed }
}

describe('workflow guest callbacks', () => {
  it('runs the six-global script API and forwards structured child options and progress', async () => {
    const test = fixture(`
      phase('Read')
      log('starting')
      return await agent(args.prompt, { label: 'Answer', provider: 'openai', model: 'small', schema: { type: 'object' } })
    `, { childResult: async () => ({ output: [], structured: { answer: 42 }, stopReason: 'completed' }) })
    await expect(runWorkflowGuest(test.host)).resolves.toEqual({ value: { answer: 42 }, stopReason: 'completed', agentsStarted: 1 })
    expect(test.requests).toEqual([{ prompt: 'answer this', provider: 'openai', model: 'small', schema: { type: 'object' } }])
    expect(test.events).toEqual([
      { type: 'phase', title: 'Read' },
      { type: 'log', message: 'starting' },
      { type: 'agent-start', info: { seq: 1, label: 'Answer', phase: 'Read', childId: 'child-1' } },
      { type: 'agent-end', info: { seq: 1, label: 'Answer', phase: 'Read', childId: 'child-1', outcome: 'completed' } },
    ])
    expect(test.disposed).toEqual([1])
  })

  it('keeps combinator functions inside the VM and maps ordinary stage failures to null', async () => {
    const { host } = fixture(`
      const first = await parallel([() => agent('a'), () => { throw new Error('ordinary') }, () => { throw { fatal: true } }])
      const second = await pipeline([1, 2, 3], (prev, item, index) => prev + item + index, value => { if (value === 5) throw 'skip'; return value * 2 })
      return { first, second }
    `)
    await expect(runWorkflowGuest(host)).resolves.toMatchObject({ value: { first: ['a', null, null], second: [4, null, 16] }, stopReason: 'completed' })
  })

  it('does not expose ambient Node globals and maps a missing return to null', async () => {
    const test = fixture('log([typeof process, typeof setTimeout, typeof fetch].join(","))')
    await expect(runWorkflowGuest(test.host)).resolves.toEqual({ value: null, stopReason: 'completed', agentsStarted: 0 })
    expect(test.events).toEqual([{ type: 'log', message: 'undefined,undefined,undefined' }])
  })

  it.each([
    ['return 42', 'completed'],
    ['throw new Error("body failed")', 'error'],
  ])('waits for progress before publishing script settlement: %s', async (settlement, stopReason) => {
    const entered = Promise.withResolvers<undefined>()
    const delivered = Promise.withResolvers<null>()
    onTestFinished(() => { delivered.resolve(null) })
    const test = fixture(`log("last"); ${settlement}`, { progress: () => { entered.resolve(undefined); return delivered.promise } })
    let finished = false
    const active = runWorkflowGuest(test.host).then((result) => { finished = true; return result })
    await entered.promise
    expect(finished).toBe(false)
    delivered.resolve(null)
    await expect(active).resolves.toMatchObject({ stopReason })
  })

  it('retains a progress failure that arrives before script completion', async () => {
    const { host } = fixture('log("progress"); await agent("work"); return 42', {
      progress: async () => { throw new Error('progress delivery failed') },
    })
    const result = await runWorkflowGuest(host)
    expect(result).toMatchObject({ value: null, stopReason: 'error', agentsStarted: 1 })
    expect(result.error).toContain('progress delivery failed')
  })

  it('coalesces a synchronous progress burst while one acknowledgement is pending', async () => {
    const first = Promise.withResolvers<undefined>()
    const second = Promise.withResolvers<undefined>()
    const firstAck = Promise.withResolvers<null>()
    const secondAck = Promise.withResolvers<null>()
    const batches: WorkflowProgress[][] = []
    let pending = 0
    let peak = 0
    const test = fixture('for (let index = 0; index < 200; index++) log(String(index)); return "done"', {
      async progress(events) {
        batches.push(events)
        peak = Math.max(peak, ++pending)
        const firstBatch = batches.length === 1
        if (firstBatch) first.resolve(undefined)
        else second.resolve(undefined)
        await (firstBatch ? firstAck.promise : secondAck.promise)
        pending -= 1
        return null
      },
    })
    let settled = false
    const active = runWorkflowGuest(test.host).then((result) => { settled = true; return result })
    onTestFinished(async () => { firstAck.resolve(null); secondAck.resolve(null); await active })
    await first.promise
    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual([{ type: 'log', message: '0' }])
    firstAck.resolve(null)
    await second.promise
    expect(batches).toHaveLength(2)
    expect(batches[1]).toEqual(Array.from({ length: 199 }, (_, index) => ({ type: 'log', message: String(index + 1) })))
    expect(peak).toBe(1)
    await setImmediate()
    expect(settled).toBe(false)
    secondAck.resolve(null)
    await expect(active).resolves.toMatchObject({ value: 'done', stopReason: 'completed' })
  })

  it('reports a rejected batch and stops dispatching its queued progress', async () => {
    const entered = Promise.withResolvers<undefined>()
    const acknowledgement = Promise.withResolvers<null>()
    const batches: WorkflowProgress[][] = []
    const test = fixture('for (let index = 0; index < 200; index++) log(String(index)); return "done"', {
      progress(events) {
        batches.push(events)
        entered.resolve(undefined)
        return acknowledgement.promise
      },
    })
    const active = runWorkflowGuest(test.host)
    onTestFinished(async () => { acknowledgement.resolve(null); await active })
    await entered.promise
    acknowledgement.reject(new Error('progress batch rejected'))
    const result = await active
    expect(result).toMatchObject({ value: null, stopReason: 'error' })
    expect(result.error).toContain('progress batch rejected')
    expect(batches).toEqual([[{ type: 'log', message: '0' }]])
  })

  it('delivers queued child lifecycle events before disposing the published child', async () => {
    const firstAck = Promise.withResolvers<null>()
    const events: WorkflowProgress[] = []
    let batches = 0
    const test = fixture('log("hold"); return await agent("work")', {
      async progress(batch) {
        events.push(...batch)
        if (++batches === 1) await firstAck.promise
        return null
      },
    })
    const active = runWorkflowGuest(test.host)
    onTestFinished(async () => { firstAck.resolve(null); await active })
    // All child callbacks are fulfilled promises; the next turn drains their microtasks.
    await setImmediate()
    expect(test.requests).toHaveLength(1)
    expect(test.disposed).toEqual([])
    expect(events).toEqual([{ type: 'log', message: 'hold' }])
    firstAck.resolve(null)
    await expect(active).resolves.toMatchObject({ value: 'work', stopReason: 'completed' })
    expect(events.map(event => event.type)).toEqual(['log', 'agent-start', 'agent-end'])
    expect(test.disposed).toEqual([1])
  })

  it('reports initialization failure before any child or progress call', async () => {
    const test = fixture('return 42', { begin: async () => { throw new Error('run already cancelled') } })
    await expect(runWorkflowGuest(test.host)).rejects.toThrow('run already cancelled')
    expect(test.requests).toEqual([])
    expect(test.events).toEqual([])
  })

  it('rejects a body that does not parse, including TypeScript-only syntax', async () => {
    for (const body of ['return (((', 'const value: number = 1; return value']) {
      await expect(runWorkflowGuest(fixture(body).host)).rejects.toThrow('workflow script does not parse')
    }
  })

  it('ends an initial synchronous loop at the VM timeout after emitting its progress', async () => {
    const test = fixture('log("before loop"); while (true) {}', {}, { syncTimeoutMs: 20 })
    const result = await runWorkflowGuest(test.host)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('Script execution timed out')
    expect(test.events).toEqual([{ type: 'log', message: 'before loop' }])
  })

  it('rejects non-JSON completion values with the workflow diagnostic', async () => {
    const result = await runWorkflowGuest(fixture('return { date: new Date(0) }').host)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain("the workflow's return value is not plain JSON data")
  })

  it('loads the shipped generated module from a data URL and retains fresh VM state per run', async () => {
    const guest = await import(`data:text/javascript,${encodeURIComponent(WORKFLOW_GUEST_SOURCE)}`) as { runWorkflowGuest: typeof runWorkflowGuest }
    const test = fixture('globalThis.count = (globalThis.count ?? 0) + 1; return await agent(String(globalThis.count))')
    await expect(guest.runWorkflowGuest(test.host)).resolves.toMatchObject({ value: '1', stopReason: 'completed' })
    await expect(guest.runWorkflowGuest(test.host)).resolves.toMatchObject({ value: '1', stopReason: 'completed' })
  })

  it('names generated helper frames without exposing the encoded guest module in errors', async () => {
    // Vitest replaces stack formatting; plain Node must honor the guest's sourceURL.
    const active = promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
      let source = ''
      for await (const chunk of process.stdin) source += chunk
      const { runWorkflowGuest } = await import('data:text/javascript,' + encodeURIComponent(source))
      const result = await runWorkflowGuest({
        begin: async () => ({
          meta: { name: 'helper-error', description: 'helper error stack' },
          body: 'return await parallel([1])',
          limits: { maxConcurrentAgents: 1, maxTotalAgents: 1, maxItemsPerCall: 1, syncTimeoutMs: 5000 },
        }),
      })
      process.stdout.write(JSON.stringify(result))
    `], { encoding: 'utf8', timeout: 30_000 })
    onTestFinished(async () => { active.child.kill(); await active.catch(() => {}) })
    active.child.stdin!.end(WORKFLOW_GUEST_SOURCE)
    const { stdout } = await active
    const result = JSON.parse(stdout) as { stopReason: string; error: string }
    expect(result.stopReason).toBe('error')
    expect(result.error.includes('dsh-workflow-guest.js:')).toBe(true)
    expect(result.error.includes('data:text/javascript')).toBe(false)
  })
})

describe('workflow child results', () => {
  it.each([
    ['failed child', { output: [], stopReason: 'error' }],
    ['missing structured value', { output: [], stopReason: 'completed' }],
  ] as const)('returns null for a %s and disposes its child', async (_name, result) => {
    const test = fixture('return await agent("work", {schema: {type: "object"}})', { childResult: async () => ({ ...result, output: [] }) })
    await expect(runWorkflowGuest(test.host)).resolves.toMatchObject({ value: null, stopReason: 'completed', agentsStarted: 1 })
    expect(test.events.at(-1)).toMatchObject({ type: 'agent-end', info: { outcome: 'failed' } })
    expect(test.disposed).toEqual([1])
  })

  it('returns text blocks and derives a short first-line label unless options override it', async () => {
    const long = 'x'.repeat(70)
    const test = fixture(`phase('default'); await agent(${JSON.stringify(`${long}\nsecond line`)}); return await agent('short', {phase: 'override'})`, {
      childResult: async () => ({ output: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'b' }], stopReason: 'completed' }),
    })
    await expect(runWorkflowGuest(test.host)).resolves.toMatchObject({ value: 'ab', stopReason: 'completed' })
    expect(test.events.filter(event => event.type === 'agent-start')).toMatchObject([
      { info: { label: `${'x'.repeat(47)}…`, phase: 'default' } },
      { info: { label: 'short', phase: 'override' } },
    ])
  })

  it('propagates child-start infrastructure failure through a combinator', async () => {
    const test = fixture('return await parallel([() => agent("work")])', {
      startChild: async () => { throw new Error('provider unavailable') },
    })
    const result = await runWorkflowGuest(test.host)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('agent() could not start a child')
    expect(test.events).toEqual([])
  })

  it('pairs and disposes a child whose result rejects, preserving a fatal pipeline failure', async () => {
    const test = fixture('return await pipeline([1], () => agent("work"))', {
      childResult: async () => { throw new Error('provider result failed') },
    })
    const result = await runWorkflowGuest(test.host)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('child agent run failed')
    expect(test.events.at(-1)).toMatchObject({ type: 'agent-end', info: { outcome: 'failed' } })
    expect(test.disposed).toEqual([1])
  })

  it('contains the rejection of an agent() promise the script dropped', async () => {
    const droppedDisposed = Promise.withResolvers<undefined>()
    onTestFinished(() => { droppedDisposed.resolve(undefined) })
    const test = fixture('agent("dropped"); return await agent("kept")', {
      async childResult({ callId }) {
        if (callId === 1) throw new Error('dropped child failed')
        await droppedDisposed.promise
        return { output: [{ type: 'text', text: 'kept result' }], stopReason: 'completed' }
      },
      async disposeChild({ callId }) {
        if (callId === 1) droppedDisposed.resolve(undefined)
        return null
      },
    })
    await expect(runWorkflowGuest(test.host)).resolves.toMatchObject({ value: 'kept result', stopReason: 'completed' })
    expect(test.events).toContainEqual({
      type: 'agent-end', info: { seq: 1, label: 'dropped', childId: 'child-1', outcome: 'failed' },
    })
  })

  it('admits queued child calls in FIFO order after each previous child finishes', async () => {
    const starts = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    const results = [Promise.withResolvers<ChildResult>(), Promise.withResolvers<ChildResult>(), Promise.withResolvers<ChildResult>()]
    onTestFinished(() => { for (const result of results) result.resolve({ output: [], stopReason: 'cancelled' }) })
    const test = fixture('return await parallel([() => agent("one"), () => agent("two"), () => agent("three")])', {}, { maxConcurrentAgents: 1 })
    const startChild = test.host.startChild.bind(test.host)
    test.host.startChild = async (request) => {
      const child = await startChild(request)
      starts[child.callId - 1]!.resolve(undefined)
      return child
    }
    test.host.childResult = ({ callId }) => results[callId - 1]!.promise
    const active = runWorkflowGuest(test.host)
    for (let index = 0; index < results.length; index++) {
      await starts[index]!.promise
      expect(test.requests).toHaveLength(index + 1)
      results[index]!.resolve({ output: [{ type: 'text', text: String(index) }], stopReason: 'completed' })
    }
    await expect(active).resolves.toMatchObject({ value: ['0', '1', '2'], stopReason: 'completed' })
    expect(test.requests.map(request => request.prompt)).toEqual(['one', 'two', 'three'])
  })
})

describe('workflow script validation', () => {
  it.each([
    ['return await agent(1)', 'non-empty prompt'],
    ['return await agent("x", new Date())', 'options must be plain JSON'],
    ['return await agent("x", [])', 'options must be an object'],
    ['return await agent("x", {effort: "high"})', 'deferred and not supported'],
    ['return await agent("x", {unknown: true})', 'not recognized'],
    ['return await agent("x", {label: 1})', 'must be a string'],
    ['return await agent("x", {schema: {type: "object", pattern: "x"}})', 'outside the supported subset'],
    ['return await parallel(1)', 'requires an array'],
    ['return await parallel([1])', 'not a function'],
    ['return await parallel([() => agent("x", {unknown: true})])', 'not recognized'],
    ['return await pipeline(1, () => 1)', 'requires an items array'],
    ['return await pipeline([])', 'requires at least one stage'],
    ['return await pipeline([], 1)', 'not a function'],
    ['phase(1)', 'non-empty title'],
    ['log(1)', 'message string'],
  ])('rejects invalid script calls: %s', async (body, message) => {
    const result = await runWorkflowGuest(fixture(body).host)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain(message)
  })

  it('applies the ordinary total-child and per-combinator item limits', async () => {
    const total = await runWorkflowGuest(fixture('await agent("one"); return await agent("two")', {}, { maxTotalAgents: 1 }).host)
    expect(total.stopReason).toBe('error')
    expect(total.error).toContain('total agent cap (1)')
    for (const body of ['return await parallel([() => 1, () => 2])', 'return await pipeline([1, 2], value => value)']) {
      const result = await runWorkflowGuest(fixture(body, {}, { maxItemsPerCall: 1 }).host)
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('per-call cap (1)')
    }
  })
})
