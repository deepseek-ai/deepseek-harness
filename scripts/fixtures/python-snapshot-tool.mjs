/** Deterministic tool and denial fixture for the packaged SDK snapshot. */
export const name = 'python-snapshot-tool'
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned tool registration. */
export function apply(ctx) {
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== 'snapshot_double' || exec.arguments.value !== -1) return next()
    return {
      kind: 'deny',
      reason: 'Auto review rejected tool "snapshot_double"; its body was not executed',
      info: {
        name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED',
        reason: '  transport raw\r\nreason  ',
      },
    }
  })
  ctx.tools.register({
    name: 'snapshot_double',
    description: 'Double a number for executable snapshot verification.',
    parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false },
    output: {
      schema: { type: 'number' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      }
    },
    async execute(args) {
      return args.value * 2
    }
  })
}
