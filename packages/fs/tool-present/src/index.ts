/** Scoped tool that declares filesystem deliveries in their owning Session. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PresentedFile } from './types.ts'

/** Stable Loader identity. */
export const name = 'tool-present'

/** Per-call delivery limit. */
export interface Config {
  /** Maximum number of files in one call. */
  maxFiles: number
}

/** Validated delivery limit. */
export const Config: z<Config> = z.object({
  maxFiles: z.number().default(8),
})

/** Services used by the scoped delivery tool. */
export const inject = ['tools', 'fs', 'sessionProjections']

/**
 * Register present with durable file references in its tool result.
 * @param ctx - agent-scoped services.
 * @param config - maximum files per call.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.maxFiles) || config.maxFiles < 1) {
    throw new Error('present requires a positive integer maxFiles')
  }
  const pending = new WeakMap<ToolExecution, { session: Session; turn: number; files: PresentedFile[] }>()
  ctx.tools.register(defineTool({
    name: 'present',
    description: 'Declare existing files accessible through the Session filesystem as final deliverables. '
      + 'When a file you create or update is an output the user asked to receive, you must call present after writing it and before your final response, including files created through Bash or code execution. '
      + 'Mentioning its path in your reply does not replace this call. The files must already exist. '
      + 'The user opens the current source files; their contents are not copied or preserved.',
    parameters: {
      files: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Path of an existing regular file. Relative paths use the Session working directory.' },
            description: { type: 'string', description: 'Brief description for the user.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          turn: { type: 'integer', required: true },
          files: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.files.map(file => `Presented ${file.path}`).join('\n') }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('present requires an agent Session')
      const boundary = ctx.sessionProjections.stateOf(exec.agent.session, 'turnBoundary')
      if (boundary === undefined || boundary.openTurnStartSeq === null) throw new Error('present requires an open turn')
      if (args.files.length === 0 || args.files.length > config.maxFiles) throw new Error(`present accepts 1 to ${config.maxFiles} files`)
      const cwd = exec.agent.session.header.cwd
      if (cwd === undefined) throw new Error('present requires a workspace')
      const options = { cwd, signal: exec.signal }
      const files: PresentedFile[] = []
      for (const file of args.files) {
        if (file.path.trim().length === 0) throw new Error('present requires a non-empty file path')
        const entry = await ctx.fs.lstat(file.path, { cwd }, exec.signal)
        if (entry !== undefined && entry.type !== 'file') throw new Error(`Cannot present ${file.path}: not a regular file`)
        const target = await ctx.fs.resolve(file.path, options)
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new FsError(`Cannot present ${file.path}: file not found. Check the path, create the file if needed, and retry.`, 'FS_NOT_FOUND')
        if (info.type !== 'file') throw new Error(`Cannot present ${file.path}: not a regular file`)
        files.push({ ...file })
      }
      exec.signal.throwIfAborted()
      pending.set(exec, { session: exec.agent.session, turn: boundary.lastTurn, files })
      return { turn: boundary.lastTurn, files }
    },
  }))
  ctx.on('tools/result', (exec, result) => {
    const delivery = pending.get(exec)
    pending.delete(exec)
    if (delivery === undefined || result.isError) return
    const { session, turn, files } = delivery
    session.append('deliverables/presented', {
      turn, callId: exec.callId, files,
    })
  })
}
