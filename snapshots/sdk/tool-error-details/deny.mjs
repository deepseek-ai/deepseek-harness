/** A fixed error producer for SDK transport coverage; it does not enable Auto. */
import { PtcToolRegistry } from '@deepseek-ai/dsh-tool-registry-ptc'

export const name = 'structured-denial-fixture'
export const inject = ['tools']
export function apply(ctx) {
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== 'bash' || exec.arguments.command !== 'echo AUTO_DENIED') return next()
    return {
      kind: 'deny',
      reason: 'Auto review rejected tool "bash"; its body was not executed',
      info: {
        name: 'AutoReviewDeniedError',
        code: 'AUTO_REVIEW_DENIED',
        reason: '  transport raw\r\nreason  ',
      },
    }
  })
  // Each request uses one supported presentation: native first, then PTC.
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'bash' || exec.parent !== undefined
      || result.error?.info?.code !== 'AUTO_REVIEW_DENIED' || exec.agent === undefined) return
    // `run_code` is the reserved entry name; built profiles do not resolve dsh-tools from scenario fixtures.
    new PtcToolRegistry(exec.agent.ctx, { name: 'run_code' }).mountRoot()
  })
}
