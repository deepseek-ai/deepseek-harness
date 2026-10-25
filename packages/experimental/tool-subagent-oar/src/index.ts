/** One delegation tool selects a configured external provider for each task. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent-names'

export const name = 'experimental-tool-subagent-oar'
export const inject = ['tools', 'subagents', 'subagentNames']

/** Deployment-owned runtime choices exposed by the external delegation tool. */
export interface Config {
  /** Model-visible runtime aliases mapped to registered subagent provider names. */
  providers: Record<string, string>
  /** Model-facing tool name (default subagent_oar). */
  toolName?: string
}

export const Config: z<Config> = z.object({
  providers: z.dict(z.string().min(1)).required(),
  toolName: z.string().min(1).default('subagent_oar'),
})

/**
 * Register a tool that selects one configured external provider per task.
 * @param ctx - shared tool registry, managed subagents, and hierarchical naming service.
 * @param config - runtime choices and the model-facing tool name.
 */
export function apply(ctx: Context, config: Config): void {
  const providers = new Map(Object.entries(config.providers))
  if (providers.size === 0 || [...providers.keys()].some(runtime => runtime.trim().length === 0)) {
    throw new Error('subagent_oar: providers must contain at least one non-empty runtime alias')
  }
  const toolName = config.toolName ?? 'subagent_oar'
  ctx.tools.register(defineTool({
    name: toolName,
    description: 'Delegate a self-contained task to a configured external agent. Choose its runtime for each call. '
      + 'The child works in its own context and does not see this conversation. '
      + 'This tool returns the child id and full agent path; a later completion notice includes its final answer. '
      + 'The child does not accept follow-up messages. Start independent tasks together and continue useful work while they run. '
      + 'When only waiting for their results remains, end your turn instead of polling.',
    parameters: {
      name: {
        type: 'string',
        description: 'Optional sibling-unique name; omission selects the first unused agent-N, starting at agent-1. Explicit names: start with a lower-case letter and use lower-case letters, digits, underscores, or hyphens.',
      },
      runtime: {
        type: 'string',
        required: true,
        enum: [...providers.keys()],
        description: 'Configured external runtime for this task.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task. Include all context the external agent needs.',
      },
      cwd: {
        type: 'string',
        description: 'Initial child working directory. Relative paths use your current directory; omission inherits it.',
      },
    },
    /* jscpd:ignore-start -- External and local delegation share the canonical
     * activation acknowledgement; their provider-selection policies remain separate. */
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}\nname: ${value.name}` }],
    },
    /* jscpd:ignore-end */
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('subagent_oar requires a calling agent')
      // The parameter enum admits only keys from this immutable configuration.
      const providerName = providers.get(args.runtime) as string
      const provider = ctx.subagents.getProvider(providerName)
      if (provider !== undefined && (provider.prepareContinuable !== undefined || provider.inheritsParentContext)) {
        throw new Error('subagent_oar requires a one-shot provider with independent conversation context')
      }
      const names = ctx.subagentNames
      const reservation = names.reserve(parent, args.name)
      try {
        const activation = await ctx.subagents.startActivation({
          provider: providerName,
          label: args.description,
          parent,
          prompt: [{ type: 'text', text: args.prompt }],
          ...args.cwd === undefined ? {} : { cwd: args.cwd },
          signal: exec.signal,
          delivery: 'parent',
        })
        try {
          names.bind(parent, activation.childId, reservation.name)
        } catch (cause: unknown) {
          throw new HarnessError(
            `Subagent ${activation.childId} started, but its name ${reservation.name} could not be recorded. `
            + 'Its execution is still managed by the subagent service. Check this child before retrying.',
            'SUBAGENT_NAME_BIND_FAILED', { cause },
          )
        }
        return { kind: 'activation' as const, subagentId: activation.childId, name: reservation.name }
      } finally {
        reservation.dispose()
      }
    },
    presentCall: args => ({ card: 'generic', title: args.description, rawInput: args }),
  }))
}
