/** Reject one scheduler preparation to exercise the terminal internal-failure path. */
export const inject = ['tools', 'loader']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime. */
export async function apply(ctx) {
  // Resolve through the running profile so packaged runs share the bundled pipeline class that ctx.tools runs.
  const { ToolExecutionPipeline } = await ctx.loader.import('@deepseek-ai/dsh-tools/pipeline')
  const stages = ToolExecutionPipeline.prototype
  const prepare = stages.prepare
  ctx.effect(() => {
    stages.prepare = async function (input) {
      if (input.callId === 'scheduler-fail') {
        stages.prepare = prepare
        throw new Error('Snapshot scheduler preparation failed')
      }
      return prepare.call(this, input)
    }
    return () => { stages.prepare = prepare }
  }, 'snapshot scheduler failure')
}
