/** Read-only Host and Client runtime API discovery for plugin development. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { presentInspectCall } from './present.ts'

export const name = 'tool-cordis'
export const inject = ['tools', 'cordisInspect']

function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new ToolContextUnavailableError('Cordis inspection requires an Agent-backed session')
  return exec.agent
}

/** Register runtime inspection over the Host providers registered once per process.
 * @param ctx Agent-scoped registration context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'cordis_inspect',
    description: 'Inspect runtime APIs before writing or configuring plugins. Omit query to discover providers, methods, and input schemas; '
      + 'then query an exact entry from that directory. Read-only: cannot invoke business Service methods or modify the runtime. '
      + 'Client queries require a connected page.',
    parameters: {
      query: {
        type: 'object', additionalProperties: false,
        properties: {
          platform: { type: 'string', required: true, enum: ['host', 'client'], description: 'Provider platform.' },
          provider: { type: 'string', required: true, description: 'Provider ID from the directory.' },
          method: { type: 'string', required: true, description: 'Method name from the directory.' },
          input: { type: 'json', description: "Arguments matching the method's input schema." },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    // Provider methods are read-only, and each Client query settles by its own request id.
    isConcurrencySafe: () => true,
    async execute({ query }, exec): Promise<JsonValue> {
      if (query === undefined) return { providers: ctx.cordisInspect.list() } as unknown as JsonValue
      const data = await ctx.cordisInspect.query(
        query.platform,
        query.provider,
        query.method,
        query.input,
        requireAgent(exec),
        exec.signal,
      )
      return { platform: query.platform, provider: query.provider, method: query.method, data }
    },
    presentCall: presentInspectCall,
  }))
}
