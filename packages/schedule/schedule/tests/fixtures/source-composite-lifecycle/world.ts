/** A real Agent and producer whose owner does not depend on Schedule. */
import { Service, type Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule'
import { ObservationSource } from '../source/world.ts'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Accepted composite input.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Accepted composite input.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Keeps target persistence and source observations independent of provider replacement. */
export default class LifecycleWorld extends Service {
  static inject = ['llm', 'agentLoop', 'agents', 'sessions', 'sessionPersistence']
  readonly producer = new ObservationSource()
  readonly adapter = new RecordingAdapter()
  readonly entered = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  readonly draining = Promise.withResolvers<undefined>()
  readonly events: string[] = []
  receiver: Fiber | undefined
  agent!: Agent
  task!: ScheduleCatalogEntry

  constructor(ctx: Context) { super(ctx, 'sourceCompositeLifecycle') }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    ctx.effect(() => ctx.llm.registerAdapter(['source-lifecycle-fixture'], this.adapter))
    ctx.effect(() => () => this.producer.dispose())
    const handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('source-composite-lifecycle-session'),
      agentOptions: { provider: 'source-lifecycle-fixture', model: 'deterministic' },
    })
    this.agent = handle.agent
    ctx.on('schedule/resolve-agent', (sessionId, next) => {
      return sessionId === this.agent.id ? Promise.resolve(this.agent) : next()
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Independent target and controlled composite input for the lifecycle fixture. */
    sourceCompositeLifecycle: LifecycleWorld
  }
}
