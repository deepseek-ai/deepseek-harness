/**
 * Model-facing literal edit, unique-match by default. It obtains an optional guard from the
 * single intent slot, calls `ctx.fs.editText` without a separate stat, then records the observed
 * version; no policy means an unconditional atomic edit.
 * @module @deepseek-ai/dsh-tool-fs/src/edit
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

/** Validated `edit` arguments after defaulting. */
interface EditInput {
  filePath: string
  oldString: string
  newString: string
  replaceAll: boolean
}

/**
 * The `edit` tool's validated arguments: the base parameters plus the two
 * escalation fields, advertised only under a confining `ctx.fs` (absent from
 * the schema otherwise, so the validator rejects them before `execute`).
 */
interface EditToolArgs {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
  sandbox_permissions?: string
  justification?: string
}

/**
 * Validate value constraints the schema DSL can't express: a non-blank
 * `file_path`, a non-empty `old_string`, and `old_string !== new_string`
 * (an equal pair would be a guaranteed no-op edit).
 * @param args - the schema-validated raw tool arguments.
 * @returns the camelCased input with `replace_all` defaulted to false.
 */
export function parseEditArgs(args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): EditInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (args.old_string.length === 0) throw new Error('old_string must be a non-empty string')
  if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ')
  return {
    filePath: args.file_path,
    oldString: args.old_string,
    newString: args.new_string,
    replaceAll: args.replace_all ?? false,
  }
}

/**
 * Format an edit success (single-match or replace-all) as a Claude-style model-facing message.
 * @param displayPath - the backend-resolved path shown to the model.
 * @param replaceAll - selects the all-occurrences wording over the single-replacement one.
 * @returns the confirmation sentence the model sees as the tool result.
 */
export function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`
}

/**
 * Register the `edit` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param sandbox - the shared sandbox-escalation API (advertisement, mode stamping, denial mapping).
 */
export function applyEditTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT'),
    text: 'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.',
  })

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: formatEditOutput(value.path, args.replace_all ?? false),
      }],
      presentationMeta: (args, value) => ({
        diffs: computeHunkDiffs(args.file_path, value.before, value.after)
          .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: EditToolArgs, exec) {
      const input = parseEditArgs(args)
      // Resolve the per-call sandbox policy (approved mode > session override
      // > backend default, plus the session cwd root) BEFORE anything executes.
      const sandboxPolicy = await sandbox.resolvePolicy('edit', args, exec)
      const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, input.filePath, sandboxPolicy?.workspaceRoot))
      // Single-slot decision: the policy plugin returns { version: vObserved } or
      // throws FS_NOT_OBSERVED; the bare default is undefined (unconditional edit).
      // No stat — the bare default never manufactures a version basis. The intent
      // slot itself can throw FS_NOT_OBSERVED for an unread target, so it sits
      // inside the try: both that refusal and the provider's guarded-mutation
      // failure get the model-facing remedy below.
      let outcome
      try {
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        outcome = await ctx.fs.editText(
          target,
          { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll },
          intent,
          exec.signal,
          sandboxPolicy,
        )
      } catch (error: unknown) {
        // A sandbox denial becomes the shared [sandbox: …] marker (the model
        // recognizes it from bash); guarded mutation failures receive their
        // stable model-facing diagnostic; anything else passes through.
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy), target.displayPath)
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return {
        path: target.displayPath,
        before: outcome.before,
        after: outcome.after,
      }
    },
    // Pure display: a diff card of the literal replacement (old_string → new_string), derived
    // from the call args. `oldText: old_string || null` matches claude-agent-acp's Edit arm;
    // new_string is a required arg here, so it maps straight to newText.
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: args.old_string || null, newText: args.new_string }],
        locations: [{ path: args.file_path }],
      }
    },
    // Applied metadata replaces the call-time snippet; errors or malformed replay metadata use
    // the generic result rendering.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}
