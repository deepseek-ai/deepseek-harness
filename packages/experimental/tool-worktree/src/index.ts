/**
 * Model tools for creating and entering a new Git worktree, entering an existing one, and returning to the
 * source checkout, through the shared runtime.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import { defineTool, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-worktree'
/** Services required to register and execute the worktree tools. */
export const inject = ['tools', 'worktrees']

/** Result fields of a created worktree. */
const CREATED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    branch: { type: 'string', required: true },
    baseCommit: { type: 'string', required: true },
    repositoryRoot: { type: 'string', required: true },
  },
} as const

/** Result fields of an entered worktree; `branch` is absent on a detached HEAD. */
const ENTERED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    branch: { type: 'string' },
    repositoryRoot: { type: 'string', required: true },
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
 * Register create_worktree, enter_worktree, and exit_worktree for model and PTC callers.
 * @param ctx - tool registry and worktree runtime.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'create_worktree',
    description: 'Create a new Git branch and worktree from a local commit, branch, or tag, then change this session\'s working directory to it. Uncommitted files stay in the source checkout. Existing names fail; enter_worktree enters an existing worktree. exit_worktree returns to the source checkout.',
    parameters: {
      name: { type: 'string', description: 'New branch name, also used as the checkout directory: a few lowercase words joined by hyphens that describe the task, such as fix-login-retry. Omit to generate a unique name.' },
      from: { type: 'string', description: 'Local commit, branch, or tag to start from. Defaults to HEAD; no fetch is performed.' },
    },
    output: {
      schema: CREATED_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new ToolContextUnavailableError('create_worktree requires a calling agent')
      return ctx.worktrees.create(exec.agent, args, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'create_worktree', rawInput: args }),
  }))
  ctx.tools.register(defineTool({
    name: 'enter_worktree',
    description: 'Change this session\'s working directory to an existing worktree that was created from the checkout this session is in. Branches and files stay as they are. exit_worktree returns to that checkout.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name the worktree was created with.' },
    },
    output: {
      schema: ENTERED_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new ToolContextUnavailableError('enter_worktree requires a calling agent')
      return ctx.worktrees.enter(exec.agent, args, exec.signal)
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
