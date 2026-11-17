/** Reject one scheduler preparation to exercise the terminal internal-failure path. */
export const inject = ['tools', 'loader']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime. */
export async function apply(ctx) {
  // Resolve through the running profile so packaged runs share the bundled error classes.
  const { NativeToolExecutor } = await ctx.loader.import('@deepseek-ai/dsh-tool-executor-native')
  ctx.on('agent/created', ({ agent }) => {
    const executor = new NativeToolExecutor(agent.ctx)
    const scheduler = executor.pipeline
    const prepare = scheduler.prepare
    scheduler.prepare = async input => {
      if (input.callId === 'scheduler-fail') {
        scheduler.prepare = prepare
        throw new Error('Snapshot scheduler preparation failed')
      }
      return prepare.call(scheduler, input)
    }
    agent.ctx.tools.setExecutor(executor)
  })
}
