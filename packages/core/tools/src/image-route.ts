/** Image-input capability check for the model route that called a tool. @module */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from './contracts.ts'

/** Refusal messages a tool supplies for its own operation and argument. */
export interface ImageRouteRefusals {
  /** Message when the provider, model, or `llm` service is unavailable. */
  readonly unresolved: string
  /**
   * Builds the message when the resolved model does not declare image input.
   * @param model - Resolved model id.
   * @returns Refusal message naming that model.
   */
  readonly unsupported: (model: string) => string
}

/**
 * Require the calling model route to declare image input. The route is the Session's latest request header
 * configuration, falling back to the agent options; a model whose capability is unknown is refused.
 * @param ctx - Plugin context that reads the optional `llm` service.
 * @param exec - Tool execution supplying the calling agent and cancellation.
 * @param refusals - Tool-specific refusal messages.
 * @returns Resolves when the route accepts images; rejects with an `Error` carrying one refusal message, or with
 *   the model-information lookup failure.
 */
export async function assertImageInputRoute(ctx: Context, exec: Pick<ToolExecution, 'agent' | 'signal'>, refusals: ImageRouteRefusals): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) throw new Error(refusals.unresolved)
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  if (info.inputModalities?.includes('image') !== true) throw new Error(refusals.unsupported(model))
}
