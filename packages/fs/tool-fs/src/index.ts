/**
 * Model-facing read, read_image, write, edit, and apply_patch tools over `ctx.fs`. This package owns schemas, validation,
 * read windows, formatting, and observation events, never a concrete provider. An optional
 * event policy supplies mutation guards; without one the tools use unconditional provider calls.
 * @module @deepseek-ai/dsh-tool-fs
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-user-approval'
import { applyReadTool, READ_LIMIT, STREAM_MIN_SIZE } from './read.ts'
import { applyWriteTool } from './write.ts'
import { applyApplyPatchTool } from './apply-patch.ts'
import { applyEditTool } from './edit.ts'
import { applyReadImageTool } from './read-image.ts'
import { READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from './read-render.ts'
import { FsSandboxController } from './sandbox.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs'

/** Services required by the filesystem tool suite. */
export const inject = ['tools', 'fs', 'systemPrompt', 'workingDirectory']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Register `read` and its guidance. Defaults to true. */
  read?: boolean
  /** Register `read_image` while an attachment store is mounted. Defaults to true. */
  readImage?: boolean
  /** Register `write` and its guidance. Defaults to true. */
  write?: boolean
  /** Register `edit` and its guidance. Defaults to true. */
  edit?: boolean
  /** Register `apply_patch` and its guidance beside `edit`. Defaults to false; shipped compositions set it on their `tool-fs` rows. */
  applyPatch?: boolean
  /** Default and maximum number of lines returned by one `read` call. */
  readLimit?: number
  /** Maximum characters returned for a single line before truncation. */
  readMaxLineLength?: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  readMaxBytes?: number
  /** Files at or above this size stream instead of loading whole into memory. */
  readStreamMinSize?: number
}

export const Config: z<Config> = z.object({
  read: z.boolean().default(true),
  readImage: z.boolean().default(true),
  write: z.boolean().default(true),
  edit: z.boolean().default(true),
  applyPatch: z.boolean().default(false),
  readLimit: z.number().default(READ_LIMIT),
  readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
  readMaxBytes: z.number().default(READ_MAX_BYTES),
  readStreamMinSize: z.number().default(STREAM_MIN_SIZE),
})

/** Configuration after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Every read cap counts lines/chars/bytes — a positive integer, or windowing arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fs: ${name} must be a positive integer`)
  }
}

/** Register the selected filesystem tools; `read_image` additionally requires a mounted attachment store. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('readLimit', resolved.readLimit)
  assertPositiveInteger('readMaxLineLength', resolved.readMaxLineLength)
  assertPositiveInteger('readMaxBytes', resolved.readMaxBytes)
  assertPositiveInteger('readStreamMinSize', resolved.readStreamMinSize)
  if (resolved.read) {
    applyReadTool(ctx, {
      limit: resolved.readLimit,
      maxLineLength: resolved.readMaxLineLength,
      maxBytes: resolved.readMaxBytes,
      streamMinSize: resolved.readStreamMinSize,
    })
  }
  // read_image is composition-conditional: without a mounted attachment store
  // the deployment cannot durably commit image bytes, so the tool never
  // registers; the execute body keeps a defensive re-check for direct callers.
  if (resolved.readImage) {
    ctx.inject(['attachments'], (imageCtx) => {
      applyReadImageTool(imageCtx)
    })
  }
  // One escalation API shared by the mutating tools: advertisement gating,
  // per-call policy resolution, and denial-marker mapping, all keyed off whether
  // the mounted ctx.fs confines (ctx.fs.sandboxMode).
  if (resolved.write || resolved.edit || resolved.applyPatch) {
    const sandbox = new FsSandboxController(ctx)
    if (resolved.write) applyWriteTool(ctx, sandbox)
    if (resolved.edit) applyEditTool(ctx, sandbox)
    if (resolved.applyPatch) applyApplyPatchTool(ctx, sandbox)
  }
}
