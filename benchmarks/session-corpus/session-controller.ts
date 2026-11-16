/** Session-controller initialization for synthetic corpus workers without attachment I/O. */

import { Service, type Context } from '@deepseek-ai/cordis'
import SessionController, { type Config } from '@deepseek-ai/dsh-api-session-controller'
import LlmRuntime from '@deepseek-ai/dsh-llm'

class BenchmarkSessionController extends SessionController {
  initialize(): Promise<void> {
    return this[Service.init]()
  }
}

/**
 * Initialize the controller against the worker's partial Host services.
 * @param ctx - worker context owning service disposal.
 * @param config - native-opener and list-scheduling settings.
 * @returns controller ready for list, search, and fork calls.
 */
export async function createBenchmarkSessionController(ctx: Context, config: Config): Promise<SessionController> {
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 100 * 1024 * 1024,
      maxImagePixels: 40_000_000,
      maxImageDimension: 2000,
      mediaTypes: ['image/png'],
    },
  } as never)
  if (ctx.get('llm') === undefined) await ctx.plugin(LlmRuntime)
  // These workers do not perform filesystem API operations or deliver Remote events.
  if (ctx.get('fs') === undefined) {
    const fs: Pick<Context['fs'], 'resolve'> = {
      resolve: async () => { throw new Error('Session corpus benchmarks do not perform filesystem API operations') },
    }
    ctx.provide('fs', fs as Context['fs'])
  }
  if (ctx.get('typertGateway') === undefined) {
    const gateway: Pick<Context['typertGateway'], 'getPendingRemoteEvents'> = { getPendingRemoteEvents: () => [] }
    ctx.provide('typertGateway', gateway as Context['typertGateway'])
  }
  let controller: BenchmarkSessionController | undefined
  await ctx.plugin({
    inject: SessionController.inject,
    apply: async (owner: Context) => {
      controller = new BenchmarkSessionController(owner, config, { canOpenPath: () => false })
      await controller.initialize()
    },
  })
  if (controller === undefined) throw new Error('Session corpus controller dependencies did not activate')
  return controller
}
