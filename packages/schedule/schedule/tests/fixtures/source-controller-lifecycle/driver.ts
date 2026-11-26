/** Execute one controlled Source creation through real Loader-owned services and inspect durable state. */
import assert from 'node:assert/strict'
import { glob, writeFile } from 'node:fs/promises'
import { Fiber } from '@deepseek-ai/cordis'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ScheduleService, { scheduleDomain, type AutomationCandidate } from '@deepseek-ai/dsh-schedule'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { installCreateGate } from './persistence.ts'

const INITIAL_INPUT = 'Inspect the completed build.'
const RECOVERY_INPUT = 'Inspect the replacement build.'

class CandidateSource {
  private readonly submit: (candidate: AutomationCandidate) => Promise<void>

  constructor(submit: (candidate: AutomationCandidate) => Promise<void>) {
    this.submit = submit
  }

  publish(text: string): Promise<void> { return this.submit({ text }) }
}

class DeterministicAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Build inspected.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Build inspected.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function errorDetails(error: unknown): object {
  if (!(error instanceof Error)) return { value: String(error) }
  return {
    name: error.name, message: error.message, stack: error.stack,
    ...'code' in error ? { code: error.code } : {},
    ...error.cause === undefined ? {} : { cause: errorDetails(error.cause) },
    ...error instanceof AggregateError ? { errors: error.errors.map(errorDetails) } : {},
  }
}

async function physicalLogs(): Promise<string[]> {
  const paths: string[] = []
  for await (const path of glob('**/*.jsonl', { cwd: `${process.cwd()}/sessions` })) paths.push(path)
  return paths
}

const [configPath, kind, phase, disposition, mode] = process.argv.slice(2)
assert.ok(configPath)
assert.ok(kind === 'new' || kind === 'new_once')
assert.ok(phase === 'before' || phase === 'after')
assert.ok(disposition === 'keep' || disposition === 'dispose')
assert.ok(mode === 'src' || mode === 'lib')
assert.equal(process.execArgv.includes('--import'), mode === 'src')
const scheduleModule = import.meta.resolve('@deepseek-ai/dsh-schedule')
assert.ok(new URL(scheduleModule).pathname.includes(mode === 'lib' ? '/lib/' : '/src/'))
const ctx = await boot('source-controller-lifecycle', resolveConfigPath(configPath, undefined))
let work: Promise<object> | undefined
let closing: Promise<void> | undefined
ctx.effect(() => async () => { await work })
const persistence = ctx.get('sessionPersistence')
assert.ok(persistence)
const gate = installCreateGate(ctx, phase)
try {
  const schedule = ctx.get('schedule')
  assert.ok(schedule instanceof ScheduleService, 'real Schedule provider must use the selected package export')
  const controller = [...ctx.loader.entries()].find(entry => entry.options.id === 'controller')
  assert.ok(controller?.fiber, 'real SessionController Loader entry must be active')
  assert.ok(ctx.get('sessionController'), 'SessionController dependencies must be satisfied')
  let controllerChild: Fiber | undefined
  let diagnosticSetupError: string | undefined
  try {
    const value: unknown = Reflect.get(schedule, 'controllerChild')
    if (value instanceof Fiber) controllerChild = value.ctx.fiber
    else diagnosticSetupError = 'Schedule controllerChild is not a Fiber'
  } catch (error: unknown) {
    diagnosticSetupError = String(error)
  }
  const bindingSnapshot = (changed?: Fiber) => {
    try {
      const inspect = (fiber: Fiber | undefined) => fiber === undefined ? null : {
        uid: fiber.uid, state: fiber.state, transitionPending: fiber.inertia !== undefined,
        registered: [...ctx.registry.values()].some(runtime => [...runtime.fibers].includes(fiber)),
      }
      const webController: unknown = Reflect.get(schedule, 'webController')
      return {
        diagnosticSetupError, changed: inspect(changed), child: inspect(controllerChild),
        providerRoot: inspect(controller.fiber?.ctx.fiber),
        webControllerPresent: webController !== undefined,
        globalControllerPresent: ctx.get('sessionController') !== undefined,
      }
    } catch (error: unknown) {
      return { diagnosticSetupError, observationError: String(error) }
    }
  }
  const bindingEvents: { role: string; previousState: number; binding: ReturnType<typeof bindingSnapshot> }[] = []
  let omittedBindingEvents = 0
  ctx.on('internal/status', (fiber, previousState) => {
    if (fiber !== controllerChild && fiber !== controller.fiber?.ctx.fiber) return
    if (bindingEvents.length >= 32) {
      omittedBindingEvents++
      return
    }
    const role = fiber === controllerChild ? 'schedule-controller-child' : 'provider-root'
    bindingEvents.push({ role, previousState, binding: bindingSnapshot(fiber) })
  })
  ctx.effect(() => ctx.llm.registerAdapter(['lifecycle-fixture'], new DeterministicAdapter()))
  const originalFiber = controller.fiber
  const originalProviderUid = originalFiber.uid
  assert.equal(typeof originalProviderUid, 'number')
  const future = '2099-01-01T00:00:00.000Z'
  assert.ok(Date.now() < Date.parse(future))
  const task = await schedule.create({
    title: 'Inspect build', prompt: 'Inspect the reported build.',
    timing: { kind: 'at', at: future },
    target: { kind, create: { cwd: process.cwd() } },
  })
  const unrelated = await schedule.create({
    title: 'Unrelated task', prompt: 'Keep independent management usable.',
    timing: { kind: 'at', at: future }, target: { kind: 'new_once' },
  })
  const domain = ctx.storageDomain.get(scheduleDomain.name)
  assert.ok(domain)
  const readTask = (id = task.id) =>
    scheduleDomain.tables.tasks.valueSchema.parse(domain.table('tasks').get(id))
  const initial = readTask()
  const source = new CandidateSource(candidate => schedule.submit(task.id, candidate))
  work = source.publish(INITIAL_INPUT).then(
    () => ({ status: 'fulfilled' }),
    (error: unknown) => ({ status: 'rejected', error: errorDetails(error) }),
  )
  const header = await Promise.race([
    gate.entered.promise,
    work.then((result) => { throw new Error(`delivery settled before create gate: ${JSON.stringify(result)}`) }),
  ])
  if (initial.target.kind === 'new_once') assert.equal(header.id, initial.target.sessionId)
  const visibleAtGate = await persistence.stat(header.id) !== undefined
  assert.equal(visibleAtGate, phase === 'after')
  const logsAtGate = await physicalLogs()
  let providerClosed = false
  if (disposition === 'dispose') {
    closing = Promise.resolve(originalFiber.dispose()).then(() => { providerClosed = true })
  }
  gate.release.resolve(undefined)
  const outcome = await work
  await closing

  const inspectDestination = async () => {
    const agent = ctx.agents.get(header.id)
    await agent?.whenIdle()
    if (agent !== undefined) assert.equal(await ctx.sessions.flush(agent.session), true)
    const persisted = await persistence.stat(header.id) !== undefined
    const inboxMessageIds: string[] = []
    const userMessageIds: string[] = []
    const userTexts: string[] = []
    if (persisted) {
      const handle = await persistence.open(header.id, 'read')
      try {
        const { events } = await handle.read(SessionLogOffset(0))
        for (const event of events) {
          if (event.type === 'agent/inbox/spliced') {
            inboxMessageIds.push(...event.data.inserted.map(message => message.id))
          }
          if (event.type === 'user/message' && event.data.source.kind === 'schedule') {
            userMessageIds.push(event.data.id)
            userTexts.push(event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
          }
        }
      } finally {
        await handle.close()
      }
    }
    const saved = readTask()
    return {
      persisted, liveAgent: ctx.agents.get(header.id) !== undefined,
      inboxInsertions: inboxMessageIds.length, userMessages: userMessageIds.length,
      inboxMessageIds, userMessageIds, userTexts,
      receipt: saved.lastDelivery !== undefined,
      receiptCount: saved.deliveryHistory?.records.length ?? 0,
      logsAfter: await physicalLogs(),
    }
  }
  const assertEmpty = (state: Awaited<ReturnType<typeof inspectDestination>>) => {
    assert.equal(state.persisted, false)
    assert.equal(state.liveAgent, false)
    assert.equal(state.inboxInsertions, 0)
    assert.equal(state.userMessages, 0)
    assert.equal(state.receipt, false)
    assert.equal(state.receiptCount, 0)
    assert.deepEqual(state.logsAfter, [])
  }
  const primary = await inspectDestination()
  const saved = readTask()
  assert.equal(saved.status, 'active')
  assert.deepEqual(saved.record, initial.record)
  assert.deepEqual(gate.attempts.map(attempt => attempt.id), [header.id])
  const report = {
    launch: { mode, execArgv: process.execArgv, scheduleModule },
    outcome, visibleAtGate, logsAtGate, originalProviderUid, providerClosed,
    reservedSessionId: header.id, creationAttempts: gate.attempts.length,
    ...primary, task: saved, pendingDelivery: saved.pendingDelivery ?? null,
  }
  let recovery: object | undefined
  if (disposition === 'dispose') {
    assert.ok('status' in outcome && outcome.status === 'rejected')
    assert.equal(originalFiber.uid, null)
    assert.equal(ctx.get('sessionController'), undefined)
    assertEmpty(primary)
    assert.deepEqual(saved.target, initial.target)
    if (kind === 'new') {
      assert.equal(saved.pendingDelivery?.targetSessionId, header.id)
    } else {
      assert.equal(saved.pendingDelivery, undefined)
      assert.equal(saved.target.kind, 'new_once')
    }

    const edited = await schedule.edit({
      id: unrelated.id, action: 'update', patch: { title: 'Edited after failed creation' },
    })
    assert.ok(!('code' in edited))
    assert.equal(readTask(unrelated.id).record.title, 'Edited after failed creation')

    await controller.update({ disabled: false })
    const replacementFiber = controller.fiber
    assert.ok(replacementFiber)
    assert.notEqual(replacementFiber, originalFiber)
    await replacementFiber.await()
    await ctx.loader.await()
    assert.equal(replacementFiber.state, ctx.fiber.state)
    assert.equal(typeof replacementFiber.uid, 'number')
    assert.notEqual(replacementFiber.uid, originalProviderUid)
    assert.ok(ctx.get('sessionController'))
    const deleted = await schedule.edit({ id: unrelated.id, action: 'delete' })
    assert.deepEqual(deleted, { id: unrelated.id, deleted: true })
    assert.ok(Date.now() < Date.parse(future))
    const beforeRetry = await inspectDestination()
    assertEmpty(beforeRetry)
    assert.deepEqual(readTask(), saved)
    assert.deepEqual(gate.attempts.map(attempt => attempt.id), [header.id])

    const bindingBeforeRecovery = bindingSnapshot()
    work = source.publish(RECOVERY_INPUT).then(
      () => ({ status: 'fulfilled' }),
      (error: unknown) => ({ status: 'rejected', error: errorDetails(error) }),
    )
    const recoveredOutcome = await work
    const bindingAfterRecovery = bindingSnapshot()
    assert.deepEqual(recoveredOutcome, { status: 'fulfilled' }, JSON.stringify({
      bindingBeforeRecovery, bindingAfterRecovery, bindingEvents, omittedBindingEvents,
    }))
    const destination = await inspectDestination()
    const recoveredTask = readTask()
    assert.equal(destination.persisted, true)
    assert.equal(destination.liveAgent, true)
    assert.equal(destination.inboxInsertions, 1)
    assert.equal(destination.userMessages, 1)
    assert.equal(destination.receiptCount, 1)
    assert.equal(destination.logsAfter.length, 1)
    assert.ok(recoveredTask.lastDelivery)
    assert.equal(recoveredTask.lastDelivery.targetSessionId, header.id)
    assert.deepEqual(destination.inboxMessageIds, [recoveredTask.lastDelivery.messageId])
    assert.deepEqual(destination.userMessageIds, [recoveredTask.lastDelivery.messageId])
    assert.equal(destination.userTexts.length, 1)
    assert.ok(destination.userTexts[0]!.includes(`source_input_json: ${JSON.stringify(RECOVERY_INPUT)}`))
    assert.ok(!destination.userTexts[0]!.includes(INITIAL_INPUT))
    assert.equal(recoveredTask.status, 'active')
    assert.deepEqual(recoveredTask.record, initial.record)
    assert.equal(recoveredTask.pendingDelivery, undefined)
    if (kind === 'new_once') {
      assert.deepEqual(recoveredTask.target, { kind: 'session', sessionId: header.id })
    } else {
      assert.deepEqual(recoveredTask.target, initial.target)
    }
    assert.deepEqual(gate.attempts.map(attempt => attempt.id), [header.id, header.id])
    recovery = {
      outcome: recoveredOutcome, beforeRetry, ...destination, task: recoveredTask,
      pendingDelivery: recoveredTask.pendingDelivery ?? null,
      creationAttempts: gate.attempts.length,
      replacementProviderUid: replacementFiber.uid,
      fifoEdited: edited, fifoDeleted: deleted,
    }
  }
  await writeFile('result.json', JSON.stringify({ ...report, recovery }, null, 2))
} finally {
  gate.release.resolve(undefined)
  try {
    await Promise.all([work, closing])
  } finally {
    await ctx.fiber.dispose()
  }
}
