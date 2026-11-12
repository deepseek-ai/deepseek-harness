/** Session-controller initialization for synthetic corpus workers without attachment I/O. */

import { Service, type Context } from '@deepseek-ai/cordis'
import SessionController, { type Config } from '@deepseek-ai/dsh-api-session-controller'

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
  const controller = new BenchmarkSessionController(ctx, config, { canOpenPath: () => false })
  await controller.initialize()
  return controller
}
