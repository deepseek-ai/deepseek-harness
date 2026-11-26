/** Observe the model context a step declares without changing either shipped root tool registry. */
import { realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { projectToolSchema } from '@deepseek-ai/dsh-tools'

export const inject = ['tools', 'agents', 'loader']

/**
 * Replace each fixture-owned directory, its resolved form, and their JSON string escapes (runtime context quotes paths
 * with JSON.stringify, which doubles Windows backslashes) with a side-independent placeholder.
 */
function placeholders(directories) {
  const pairs = Object.entries(directories).flatMap(([placeholder, path]) => [path, realpathSync(path)]
    .flatMap(form => [[form, placeholder], [JSON.stringify(form).slice(1, -1), placeholder]]))
  pairs.sort(([left], [right]) => right.length - left.length)
  const replace = value => {
    if (typeof value === 'string') return pairs.reduce((text, [path, placeholder]) => text.replaceAll(path, placeholder), value)
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    return value
  }
  return replace
}

export function apply(ctx, config) {
  const normalize = placeholders(config.directories)
  let observed
  // Prepended so the observation includes every other listener's contribution.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (context.toolStep !== undefined) {
      observed = normalize({
        // Code unit order, the order the test sorts request tool names in.
        tools: context.toolStep.declarations.map(tool => projectToolSchema(tool, true)).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
        sections: assembly.sections.map(({ name, text }) => ({ name, text })),
        contexts: assembly.contexts.map(({ name, text }) => ({ name, text })),
        hmr: ctx.get('hmr') !== undefined,
      })
      await writeFile(config.output, JSON.stringify(observed))
    }
    return assembly
  }, { prepend: true })
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
    if (presets === undefined) throw new Error('Desktop context parity requires the shipped presets')
    const handle = await ctx.agents.create({
      sessionId: 'tool-parity', cwd: config.cwd,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      setup: scope => presets.mount(scope, config.preset).then(() => undefined),
    })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect tools' }], source: { kind: 'user', ...config.clientTimeZone === undefined ? {} : { clientTimeZone: config.clientTimeZone } } }))
      await handle.agent.whenIdle()
      if (observed === undefined) throw new Error('Desktop did not assemble a model step')
      return observed
    } finally {
      await handle.dispose()
    }
  }
}
