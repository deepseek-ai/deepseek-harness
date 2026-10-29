/** Observe step-admitted capabilities without changing either shipped tool executor. */
import { writeFile } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['tools', 'agents', 'loader']

export function apply(ctx, config) {
  let observed
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (context.toolSet !== undefined) {
      observed = {
        names: ctx.tools.definitions(context.scope, context.toolSet).map(tool => tool.name).sort(),
        hmr: ctx.get('hmr') !== undefined,
      }
      await writeFile(config.output, JSON.stringify(observed))
    }
    return next()
  })
  if (config.preset === undefined) return
  const receive = message => {
    if (message === 'stop-tool-parity') {
      // Run the CLI shutdown handler: Windows OS signals terminate before its cleanup.
      process.emit('SIGTERM')
      return
    }
    if (message !== 'collect-tool-parity') return
    void collect().then(
      result => process.send({ result }),
      error => process.send({ error: String(error.stack ?? error) }),
    )
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => process.off('message', receive)
  })
  async function collect() {
    await ctx.loader.await()
    const presets = ctx.get('agentPresets')
    if (presets === undefined) throw new Error('Web tool parity requires the shipped presets')
    const handle = await ctx.agents.create({
      sessionId: 'tool-parity', cwd: config.cwd,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      setup: scope => presets.mount(scope, config.preset).then(() => undefined),
    })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect tools' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      if (observed === undefined) throw new Error('Web did not assemble a model step')
      return observed
    } finally {
      await handle.dispose()
    }
  }
}
