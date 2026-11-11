/** Deterministic observations and model adapter surrounding real task and Session services. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule'
import { AutomationSource } from '@deepseek-ai/dsh-source/source'

/** Explicit observation producer; it owns no timers or external connections. */
export class ObservationSource extends AutomationSource<string> {
  /**
   * Publish one supplied observation.
   * @param value - Sample selected by the test.
   * @returns Completion of all subscribed consumers.
   */
  sample(value: string): Promise<void> {
    return this.emit(value)
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
    yield { type: 'text-delta', index: 0, text: 'Observed both inputs.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Observed both inputs.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Owns input producers and a persisted Agent; downstream subscriptions have a separate Loader owner. */
export default class SourceComposition extends Service {
  static inject = ['llm', 'agentLoop', 'agents', 'sessions', 'sessionPersistence', 'schedule']
  readonly left = new ObservationSource()
  readonly right = new ObservationSource()
  readonly adapter = new RecordingAdapter()
  agent!: Agent
  task!: ScheduleCatalogEntry

  constructor(ctx: Context) {
    super(ctx, 'sourceComposition')
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    ctx.effect(() => ctx.llm.registerAdapter(['source-fixture'], this.adapter))
    ctx.effect(() => async () => {
      await Promise.all([this.left.dispose(), this.right.dispose()])
    })
    const handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('source-composition-session'),
      agentOptions: { provider: 'source-fixture', model: 'deterministic' },
    })
    this.agent = handle.agent
    ctx.on('schedule/resolve-agent', (sessionId, next) => {
      return sessionId === this.agent.id ? Promise.resolve(this.agent) : next()
    })
    this.task = await ctx.schedule.create({
      title: 'Compare observations',
      prompt: 'Compare both observations and report their differences.',
      timing: { kind: 'at', at: '2099-01-01T00:00:00.000Z' },
      target: { kind: 'session', sessionId: this.agent.id },
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Test-owned external samples and the real persisted target task. */
    sourceComposition: SourceComposition
  }
}
