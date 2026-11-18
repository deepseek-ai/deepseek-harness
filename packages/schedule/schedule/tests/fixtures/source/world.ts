/** Deterministic observations and model adapter surrounding real task and Session services. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AutomationCandidate, ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule'

/** Explicit observation producer; its owner supplies admission and drains accepted submissions. */
export class ObservationSource {
  private readonly pending = new Set<Promise<void>>()
  private readonly submit: (candidate: AutomationCandidate) => Promise<void>

  /** @param submit - Submit one observation through the owning plugin's active Context. */
  constructor(submit: (candidate: AutomationCandidate) => Promise<void>) {
    this.submit = submit
  }

  /**
   * Submit one supplied observation.
   * @param value - Sample selected by the test.
   * @returns Completion of the task's persisted input and receipt.
   */
  async sample(value: string): Promise<void> {
    const work = this.submit({ text: value })
    this.pending.add(work)
    const settled = (): void => { this.pending.delete(work) }
    void work.then(settled, settled)
    return work
  }

  /**
   * Wait for accepted submissions after the owning Context stops admission.
   * @returns Settles after pending submissions; each sample retains its own failure result.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending])
  }
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Observed the input.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Observed the input.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Owns persisted tasks and an Agent; a separate Loader entry owns the ordinary producers. */
export default class SourceComposition extends Service {
  static inject = ['llm', 'agentLoop', 'agents', 'sessions', 'sessionPersistence', 'schedule']
  first!: ObservationSource
  second!: ObservationSource
  readonly adapter = new RecordingAdapter()
  agent!: Agent
  firstTask!: ScheduleCatalogEntry
  secondTask!: ScheduleCatalogEntry

  constructor(ctx: Context) {
    super(ctx, 'sourceComposition')
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    ctx.effect(() => ctx.llm.registerAdapter(['source-fixture'], this.adapter))
    const handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('source-composition-session'),
      agentOptions: { provider: 'source-fixture', model: 'deterministic' },
    })
    this.agent = handle.agent
    ctx.on('schedule/resolve-agent', (sessionId, next) => {
      return sessionId === this.agent.id ? Promise.resolve(this.agent) : next()
    })
    const createTask = (title: string) => ctx.schedule.create({
      title,
      prompt: 'Inspect the observation and report its result.',
      timing: { kind: 'at', at: '2099-01-01T00:00:00.000Z' },
      target: { kind: 'session', sessionId: this.agent.id },
    })
    this.firstTask = await createTask('Inspect build observation')
    this.secondTask = await createTask('Inspect test observation')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Test-owned ordinary producers and their real persisted target tasks. */
    sourceComposition: SourceComposition
  }
}
