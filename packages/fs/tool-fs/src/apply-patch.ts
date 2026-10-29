/** Codex-style multi-file patch tool over the guarded patch executor. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executePatch } from './patch/index.ts'
import { patchOutputSchema, patchToolValue, renderPatch, patchPresentationMeta } from './apply-patch-output.ts'
import { presentPatchCall, presentPatchResult } from './apply-patch-presentation.ts'
import type { FsEscalationArgs, FsSandboxController } from './sandbox.ts'

/** Model arguments after tool-schema validation. */
interface ApplyPatchArgs extends FsEscalationArgs { input: string }

/**
 * Register the patch tool and scope-aware guidance using the shared mutation controller.
 * @param ctx - plugin effect scope and filesystem services.
 * @param sandbox - per-call policy resolver and denial mapper.
 */
export function applyApplyPatchTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:apply_patch', order: ctx.systemPrompt.getSectionOrder('TOOL_APPLY_PATCH'),
    text: ({ scope }) => ctx.tools.get('apply_patch', scope) === undefined ? ''
      : 'Prefer apply_patch over separate edit calls for changes across files or separated regions. '
        + 'Read a file before updating, deleting, or moving it (the default fs-observation-policy requires it), unless you just created or edited it in this session. '
        + 'The whole patch is checked first (syntax, hunk matching, missing files) and a rejected patch changes nothing; '
        + 'once applying starts, operations run in order, stop at the first failure, and are not rolled back, so re-read affected files before retrying when needed.',
  })
  ctx.tools.register(defineTool({
    name: 'apply_patch',
    description: 'Create, update, delete, or move UTF-8 text files with one Codex-style patch; '
      + 'prefer it over multiple edit calls when a change spans several files or separated regions.',
    parameters: {
      // Named `input` as in the Codex apply_patch tool; models trained on it send that key.
      input: { type: 'string', required: true,
        description: 'Codex patch text: start with *** Begin Patch and end with *** End Patch. '
          + 'Use *** Add File: path with + lines; *** Update File: path, optionally followed by *** Move to: path, '
          + 'with @@ or @@ context and space-prefixed context, + added, or - removed lines; '
          + '*** End of File anchors the last hunk to the file end. Use *** Delete File: path to delete. '
          + 'Paths are relative to the Session working directory. Read existing files before updating, deleting, or moving them.',
      },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: patchOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderPatch(value) }],
      presentationMeta: (_args, value) => patchPresentationMeta(value),
    },
    async execute(args: ApplyPatchArgs, exec) {
      const sandboxPolicy = await sandbox.resolvePolicy('apply_patch', args, exec)
      return patchToolValue(await executePatch(ctx, sandbox, exec, { patch: args.input, sandboxPolicy }))
    },
    presentCall: args => presentPatchCall(args.input),
    presentResult: (_args, result) => presentPatchResult(result),
  }))
}
