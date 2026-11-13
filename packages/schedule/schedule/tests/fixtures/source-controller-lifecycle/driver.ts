/** Execute one controlled Source creation through real Loader-owned services and inspect durable state. */
import assert from 'node:assert/strict'
import { glob, writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ScheduleService, { scheduleDomain, type AutomationCandidate } from '@deepseek-ai/dsh-schedule'
import { AutomationSource } from '@deepseek-ai/dsh-schedule/source'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { installCreateGate } from './persistence.ts'

class CandidateSource extends AutomationSource<AutomationCandidate> {
  publish(): Promise<void> { return this.emit({ text: 'Inspect the completed build.' }) }
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
  return Array.fromAsync(glob('**/*.jsonl', { cwd: `${process.cwd()}/sessions` }))
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
const source = new CandidateSource()
let work: Promise<object> | undefined
let closing: Promise<void> | undefined
const persistence = ctx.get('sessionPersistence')
assert.ok(persistence)
const gate = installCreateGate(ctx, phase)
try {
  const schedule = ctx.get('schedule')
  assert.ok(schedule instanceof ScheduleService, 'real Schedule provider must use the selected package export')
  const controller = [...ctx.loader.entries()].find(entry => entry.options.id === 'controller')
  assert.ok(controller?.fiber, 'real SessionController Loader entry must be active')
  assert.ok(ctx.get('sessionController'), 'SessionController dependencies must be satisfied')
  ctx.effect(() => ctx.llm.registerAdapter(['lifecycle-fixture'], new DeterministicAdapter()))
  const task = await schedule.create({
    title: 'Inspect build', prompt: 'Inspect the reported build.',
    timing: { kind: 'at', at: '2099-01-01T00:00:00.000Z' },
    target: { kind, create: { cwd: process.cwd() } },
  })
  schedule.input(task.id).connect(source.output)
  work = source.publish().then(
    () => ({ status: 'fulfilled' }),
    (error: unknown) => ({ status: 'rejected', error: errorDetails(error) }),
  )
  const header = await Promise.race([
    gate.entered.promise,
    work.then((result) => { throw new Error(`delivery settled before create gate: ${JSON.stringify(result)}`) }),
  ])
  const visibleAtGate = await persistence.stat(header.id) !== undefined
  assert.equal(visibleAtGate, phase === 'after')
  const logsAtGate = await physicalLogs()
  let providerClosed = false
  if (disposition === 'dispose') {
    closing = Promise.resolve(controller.fiber.dispose()).then(() => { providerClosed = true })
  }
  const ownerUidAtRelease = controller.fiber.uid
  assert.equal(providerClosed, false, 'provider disposal must still await borrowed work')
  gate.release.resolve(undefined)
  const outcome = await work
  await closing
  const agent = ctx.agents.get(header.id)
  await agent?.whenIdle()
  if (agent !== undefined) await ctx.sessions.flush(agent.session)
  const persisted = await persistence.stat(header.id) !== undefined
  let inboxInsertions = 0
  let userMessages = 0
  if (persisted) {
    const handle = await persistence.open(header.id, 'read')
    try {
      const { events } = await handle.read(SessionLogOffset(0))
      inboxInsertions = events.filter(event => event.type === 'agent/inbox/spliced')
        .flatMap(event => event.data.inserted).length
      userMessages = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'schedule').length
    } finally {
      await handle.close()
    }
  }
  const domain = ctx.storageDomain.get(scheduleDomain.name)
  assert.ok(domain)
  const saved = domain.table('tasks').get(task.id)
  await writeFile('result.json', JSON.stringify({
    launch: { mode, execArgv: process.execArgv, scheduleModule },
    outcome, visibleAtGate, logsAtGate, logsAfter: await physicalLogs(), ownerUidAtRelease, providerClosed,
    persisted,
    liveAgent: agent !== undefined, inboxInsertions, userMessages,
    receipt: saved?.lastDelivery !== undefined,
    pendingDelivery: saved?.pendingDelivery,
  }, null, 2))
} finally {
  gate.release.resolve(undefined)
  try {
    await Promise.all([work, closing])
  } finally {
    try { await source.dispose() } finally { await ctx.fiber.dispose() }
  }
}
