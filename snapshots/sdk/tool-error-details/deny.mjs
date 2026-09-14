/** A fixed error producer for SDK transport coverage; it does not enable Auto. */
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
}
