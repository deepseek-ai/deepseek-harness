/** Model tool for creating and entering a new Git worktree through the shared runtime. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-worktree'
/** Services required to register and execute the worktree tool. */
export const inject = ['tools', 'worktrees']

/**
 * Register create_worktree for model and PTC callers.
 * @param ctx - tool registry and worktree runtime.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'create_worktree',
    description: 'Create a new Git branch and worktree from a local commit, branch, or tag, then change this session\'s working directory to it. Defaults to HEAD and a generated name. Uncommitted files stay in the source checkout. Existing names fail. Use working_directory with cd to leave; the checkout and branch remain.',
    parameters: {
      name: { type: 'string', description: 'New branch name, also used as the checkout directory. Omit to generate a unique name.' },
      from: { type: 'string', description: 'Local commit, branch, or tag to start from. Defaults to HEAD; no fetch is performed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          baseCommit: { type: 'string', required: true },
          repositoryRoot: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('create_worktree requires a calling agent')
      return ctx.worktrees.create(exec.agent, args, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'create_worktree', rawInput: args }),
  }))
}
