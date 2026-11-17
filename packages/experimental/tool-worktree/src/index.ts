/**
 * Model tools for entering a Git worktree, which is created when no worktree has the requested name, and for
 * returning to the source checkout, through the shared runtime.
 */

import type { Context } from '@deepseek-ai/cordis'
import { WorktreeError } from '@deepseek-ai/dsh-experimental-worktree'
import { defineTool, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-worktree'
/** Services required to register and execute the worktree tools. */
export const inject = ['tools', 'worktrees']

/** Result fields of the worktree a Session entered; a created one adds `baseCommit`, and `branch` is absent on a detached HEAD. */
const ENTERED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    branch: { type: 'string' },
    baseCommit: { type: 'string' },
    repositoryRoot: { type: 'string', required: true },
    created: { type: 'boolean', required: true },
  },
} as const

/** Result fields of the worktree a Session left: those of its creation, or of its entry. */
const EXITED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    branch: { type: 'string' },
    baseCommit: { type: 'string' },
    repositoryRoot: { type: 'string', required: true },
  },
} as const

/**
 * Register enter_worktree and exit_worktree for model and PTC callers.
 * @param ctx - tool registry and worktree runtime.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'enter_worktree',
    description: 'Change this session\'s working directory to a Git worktree of the checkout it is in. An existing worktree named name is entered as it is. Otherwise a new branch and worktree are created from a local commit, branch, or tag, and uncommitted files stay in the source checkout. exit_worktree returns to the source checkout.',
    parameters: {
      name: { type: 'string', description: 'Worktree to enter, also the branch name and checkout directory of a new one: a few lowercase words joined by hyphens that describe the task, such as fix-login-retry. Omit to create a worktree with a generated name.' },
      from: { type: 'string', description: 'Local commit, branch, or tag a new worktree starts from. Defaults to HEAD; no fetch is performed. Fails when the worktree already exists.' },
    },
    output: {
      schema: ENTERED_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute({ name, from }, exec) {
      if (exec.agent === undefined) throw new ToolContextUnavailableError('enter_worktree requires a calling agent')
      // A start revision asks for a new worktree, as does a call without a name.
      if (name !== undefined && from === undefined) {
        try {
          return { ...await ctx.worktrees.enter(exec.agent, { name }, exec.signal), created: false }
        } catch (error) {
          if (!(error instanceof WorktreeError && error.code === 'WORKTREE_NOT_FOUND')) throw error
        }
      }
      // The parameter object is open, so only the declared fields reach the runtime; it never fetches for this tool.
      const request = { ...name === undefined ? {} : { name }, ...from === undefined ? {} : { from } }
      return { ...await ctx.worktrees.create(exec.agent, request, exec.signal), created: true }
    },
    presentCall: args => ({ card: 'generic', title: 'enter_worktree', rawInput: args }),
  }))
  ctx.tools.register(defineTool({
    name: 'exit_worktree',
    description: 'Change this session\'s working directory from the worktree it is in back to the checkout it entered that worktree from, and report the worktree left. The worktree and its branch remain.',
    parameters: {},
    output: {
      schema: EXITED_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args: Record<string, never>, exec) {
      if (exec.agent === undefined) throw new ToolContextUnavailableError('exit_worktree requires a calling agent')
      return ctx.worktrees.exit(exec.agent, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'exit_worktree', rawInput: args }),
  }))
}
