/** Package-local scripted child boundary for deterministic tool-subagent tests. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'

const DEFAULT_CAPABILITIES: SubagentCapabilities = {
  agentOptions: true,
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
}

/** Options for one scripted provider fixture. */
export interface Config {
  /** Registry name to register under. */
  name: string
  /** Final text returned by the scripted child. */
  reply?: string
  /** Terminal result reason. */
  stopReason?: SubagentStopReason
  /** Safe non-assistant detail for a non-completed result. */
  diagnostic?: string
  /** Start-time features advertised by the provider. */
  capabilities?: Partial<SubagentCapabilities>
  /** Whether tool descriptions say the child inherits completed turns. */
  inheritsParentContext?: boolean
  /** Provider-owned child route defaults. */
  agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  /** Structured value returned when the request asks for one. */
  structured?: unknown
  /** Observes each start; the child's result additionally waits for the returned promise. */
  onStart?: (request: SubagentStartRequest) => Promise<void> | void
}

/** Scripted provider whose result aborts if its signal or disposer wins first. */
class ScriptedSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  private started = 0

  constructor(
    readonly name: string,
    private readonly config: Config,
  ) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities }
    this.inheritsParentContext = config.inheritsParentContext ?? false
  }

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    if (request.signal.aborted) throw new Error('scripted subagent start aborted before publication')
    const reply = this.config.reply ?? 'scripted subagent reply'
    const output: ContentBlock[] = [{ type: 'text', text: reply }]
    const wantsStructured = request.outputSchema !== undefined && this.capabilities.outputSchema
    const stopReason = this.config.stopReason ?? 'completed'
    const state = { cancelled: false }
    const cancelled = Promise.withResolvers<undefined>()
    const onAbort = (): void => { state.cancelled = true; cancelled.resolve(undefined) }
    request.signal.addEventListener('abort', onAbort, { once: true })
    await Promise.resolve()
    if (state.cancelled) {
      request.signal.removeEventListener('abort', onAbort)
      throw new Error('scripted subagent start aborted before publication')
    }

    const resultFor = (): SubagentResult => {
      const terminal = state.cancelled ? 'aborted' : stopReason
      return {
        output,
        ...wantsStructured ? { structured: this.config.structured ?? { reply } } : {},
        ...this.config.diagnostic !== undefined && terminal !== 'completed'
          ? { diagnostic: this.config.diagnostic }
          : {},
        stopReason: terminal,
      }
    }
    const gate = Promise.resolve(this.config.onStart?.(request))
    const result = Promise.race([gate, cancelled.promise]).then(resultFor).finally(() => {
      request.signal.removeEventListener('abort', onAbort)
    })

    return {
      id: SessionId(`scripted-subagent:${this.name}:${request.parent.id}:${++this.started}`),
      result,
      dispose(): Promise<void> {
        state.cancelled = true
        cancelled.resolve(undefined)
        request.signal.removeEventListener('abort', onAbort)
        return Promise.resolve()
      },
    }
  }
}

/**
 * Mount one scripted provider through an effect-scoped local plugin.
 * @param ctx - context carrying the real subagent registry.
 * @param config - scripted provider identity and outcome.
 * @returns the fixture plugin's disposable fiber.
 */
export function mountScriptedProvider(ctx: Context, config: Config) {
  return ctx.plugin({
    name: 'scripted-subagent-provider',
    inject: ['subagents'],
    apply(pluginCtx: Context): void {
      const provider = new ScriptedSubagentProvider(config.name, config)
      pluginCtx.subagents.registerProvider(config.agentRouteDefaults === undefined
        ? provider
        : Object.assign(provider, { agentRouteDefaults: config.agentRouteDefaults }))
    },
  })
}
