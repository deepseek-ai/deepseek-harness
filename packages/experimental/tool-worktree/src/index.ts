/** Model tools for creating and entering a new Git worktree, and for returning to its source checkout, through the shared runtime. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-worktree'
/** Services required to register and execute the worktree tools. */
export const inject = ['tools', 'worktrees']

/** Result fields both tools report for one worktree. */
const WORKTREE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    branch: { type: 'string', required: true },
    baseCommit: { type: 'string', required: true },
    repositoryRoot: { type: 'string', required: true },
  },
} as const

/**
 * Register create_worktree and exit_worktree for model and PTC callers.
 * @param ctx - tool registry and worktree runtime.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'create_worktree',
    description: 'Create a new Git branch and worktree from a local commit, branch, or tag, then change this session\'s working directory to it. Uncommitted files stay in the source checkout. Existing names fail. exit_worktree returns to the source checkout.',
    parameters: {
      name: { type: 'string', description: 'New branch name, also used as the checkout directory: a few lowercase words joined by hyphens that describe the task, such as fix-login-retry. Omit to generate a unique name.' },
      from: { type: 'string', description: 'Local commit, branch, or tag to start from. Defaults to HEAD; no fetch is performed.' },
    },
    output: {
      schema: WORKTREE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('create_worktree requires a calling agent')
      return ctx.worktrees.create(exec.agent, args, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'create_worktree', rawInput: args }),
  }))
  ctx.tools.register(defineTool({
    name: 'exit_worktree',
    description: 'Change this session\'s working directory from the worktree it is in back to the checkout that worktree was created from, and report the worktree left. The worktree and its branch remain.',
    parameters: {},
    output: {
      schema: WORKTREE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args: Record<string, never>, exec) {
      if (exec.agent === undefined) throw new Error('exit_worktree requires a calling agent')
      return ctx.worktrees.exit(exec.agent, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'exit_worktree', rawInput: args }),
  }))
}
