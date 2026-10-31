/**
 * The model-facing `office` tool: render document pages as images the model sees, convert documents between formats,
 * and recalculate workbooks through the shared `officeKit` service. The tool stays registered while that service is
 * absent, and each call then fails as `unavailable`. Reads use the filesystem backend's read authority; each call reads
 * one source byte before the service runs, so a cached result never answers a call that cannot read the source.
 * Converted files stay in the Office kit's private output store; the model copies them into the workspace with the
 * shell, so this tool writes no workspace file.
 * @module @deepseek-ai/dsh-tool-office
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { OfficeKitError, OfficeSourceKey, type OfficeKit, type OfficeKitSource } from '@deepseek-ai/dsh-office-kit'
import { assertImageInputRoute, defineTool, type GenericCallView, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { checkArguments, checkOutputFormat, extensionOf, inputFamily, OUTPUT_FORMATS, type OfficeArgs, type OfficeFamily } from './formats.ts'
import { renderFileContent, renderImagesContent, type OfficeFileValue, type OfficeRenderValue } from './content.ts'

export type { OfficeFileValue, OfficeRenderValue, OfficeRenderedImage } from './content.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-office'

/** Required services; `officeKit` is read at each call, and `attachments` and `llm` are checked when rendering. */
export const inject = ['tools', 'fs', 'workingDirectory']

/** Bounds on one render result; deployment attachment limits apply when they are lower. */
export interface Config {
  /** Maximum images one render returns, including worksheet fragments. */
  maxImages: number
  /** Maximum pixels of each image. */
  maxImagePixels: number
  /** Maximum width and height of each image in pixels. */
  maxImageDimension: number
  /** Maximum PNG bytes across all images of one render. */
  maxImageBytes: number
}

/** Validated render bounds. */
export const Config: z<Partial<Config>, Config> = z.object({
  maxImages: z.natural().min(1).max(10_000).default(20),
  maxImagePixels: z.natural().min(1).max(16_777_216).default(8_388_608),
  maxImageDimension: z.natural().min(1).max(16_777_216).default(8192),
  maxImageBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(32 * 1024 * 1024),
})

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer' },
    sheet: { type: 'string' },
    range: { type: 'string' },
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', const: 'image/png', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    originalDimensions: {
      type: 'object', additionalProperties: false,
      properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } },
    },
  },
} as const

const MISSING_FONTS_SCHEMA = { type: 'array', required: true, items: { type: 'string' } } as const

/**
 * Register the `office` tool.
 * @param ctx - registration scope; disposing it removes the tool.
 * @param config - validated render bounds.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'office',
    description: 'Render document pages as images you can view, convert a document to another format, or recalculate spreadsheet formulas. '
      + 'Accepts Word (doc, docx, odt), Excel (xls, xlsx, ods), and PowerPoint (ppt, pptx, odp) files; render also accepts PDF.',
    parameters: {
      operation: {
        type: 'string', required: true, enum: ['render', 'convert', 'recalculate'],
        description: 'render returns page images; convert and recalculate return a temporary file to copy to its destination.',
      },
      input: { type: 'string', required: true, description: 'Path of the document to read; it is not modified.' },
      format: {
        type: 'string', enum: OUTPUT_FORMATS,
        description: 'convert and recalculate: output format. Word converts to pdf, docx, odt, or txt; Excel to pdf, xlsx, ods, or csv; '
          + 'PowerPoint to pdf, pptx, or odp. recalculate writes xlsx or ods.',
      },
      pages: {
        type: 'array', items: { type: 'integer' },
        description: 'render: one-based pages or slides; omit for all. Spreadsheets use sheet and range instead.',
      },
      sheet: {
        type: 'string',
        description: 'Exact worksheet name. render: omit to render every visible sheet. convert: required for CSV from a workbook with several sheets.',
      },
      range: { type: 'string', description: 'render: A1 range in sheet, such as A1:H40; omit for the used area.' },
      dpi: { type: 'integer', description: 'render: resolution from 24 to 600; default 144.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object', additionalProperties: false,
            properties: {
              operation: { type: 'string', const: 'render', required: true },
              path: { type: 'string', required: true, description: 'Canonical absolute input path.' },
              pageCount: { type: 'integer', required: true, description: 'Pages or slides of a document, or visible worksheets.' },
              dpi: { type: 'integer', required: true },
              images: { type: 'array', required: true, items: IMAGE_SCHEMA },
              missingFonts: MISSING_FONTS_SCHEMA,
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              operation: { type: 'string', enum: ['convert', 'recalculate'], required: true },
              path: { type: 'string', required: true, description: 'Canonical absolute input path.' },
              file: { type: 'string', required: true, description: 'Absolute path of the temporary output file.' },
              format: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              pageCount: { type: 'integer', description: 'Pages of a PDF output.' },
              missingFonts: MISSING_FONTS_SCHEMA,
            },
          },
        ],
      },
      render: (_args, value) => value.operation === 'render' ? renderImagesContent(value) : renderFileContent(value),
      presentationMeta: (_args, value) => value.operation === 'render' ? { path: value.path } : { path: value.path, file: value.file },
    },
    isConcurrencySafe: args => args.operation === 'render',
    async execute(args: OfficeArgs, exec): Promise<OfficeRenderValue | OfficeFileValue> {
      const family = inputFamily(args.operation, args.input)
      checkArguments(args, family)
      const resolveOptions = await sessionResolveOptions(ctx, exec)
      const { target, info } = await readableInput(ctx, args.input, resolveOptions)
      try {
        await authorizeContent(ctx, target, info, exec.signal)
      } catch (error) { throw officeFailure(args.operation, target.displayPath, error) }
      const kit = ctx.get('officeKit')
      if (kit === undefined) {
        throw officeFailure(args.operation, target.displayPath, new OfficeKitError('unavailable', 'The document converter is unavailable.'))
      }
      const source = officeSource(ctx, exec, target, info)
      if (args.operation === 'render') return render(ctx, kit, config, exec, args, target, source)
      // `inputFamily` rejects PDF for convert and recalculate.
      return convertFile(ctx, kit, exec, args, family as Exclude<OfficeFamily, 'pdf'>, target, source)
    },
    presentCall(args): GenericCallView {
      const title = args.operation === 'render' ? `Render ${args.input}`
        : args.operation === 'convert' ? `Convert ${args.input}${args.format === undefined ? '' : ` to ${args.format}`}`
          : `Recalculate ${args.input}`
      return {
        card: 'generic', title, kind: args.operation === 'render' ? 'read' : 'other',
        locations: [{ path: args.input }],
      }
    },
  }))
}

/** Resolution options for the Session's current directory and the call's cancellation. */
async function sessionResolveOptions(ctx: Context, exec: ToolExecution): Promise<{ cwd?: string; signal: AbortSignal }> {
  const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  return { ...cwd === undefined ? {} : { cwd }, signal: exec.signal }
}

/** Resolve an input through the filesystem backend and require a regular file. */
async function readableInput(
  ctx: Context, path: string, options: { cwd?: string; signal: AbortSignal },
): Promise<{ target: FsTarget; info: FsInfo }> {
  const target = await ctx.fs.resolve(path, options)
  const info = await ctx.fs.stat(target, options.signal)
  if (info === undefined) throw new Error(`cannot read "${target.displayPath}": not found`)
  if (info.type !== 'file') throw new Error(`cannot read "${target.displayPath}": not a regular file`)
  return { target, info }
}

/** Refuse a source whose type or version differs from its authorizing stat. */
async function assertUnchanged(ctx: Context, target: FsTarget, info: FsInfo, signal: AbortSignal): Promise<void> {
  const current = await ctx.fs.stat(target, signal)
  if (current?.type !== 'file' || current.version !== info.version) throw new OfficeKitError('source-changed', 'The source changed.')
}

/**
 * Confirm this call may read the source content before the Office service can answer from its cache, which skips the
 * deferred read. Reads one byte, then refuses a source changed since its authorizing stat.
 */
async function authorizeContent(ctx: Context, target: FsTarget, info: FsInfo, signal: AbortSignal): Promise<void> {
  await ctx.fs.readByteRange(target, { offset: 0, length: 1 }, signal)
  await assertUnchanged(ctx, target, info, signal)
}

/** A deferred bounded read that refuses a source changed since its authorizing stat. */
function officeSource(ctx: Context, exec: ToolExecution, target: FsTarget, info: FsInfo): OfficeKitSource {
  return {
    key: OfficeSourceKey(JSON.stringify([exec.agent?.session.id ?? null, ctx.fs.processPath(target)])),
    version: info.version,
    ...info.size === undefined ? {} : { bytes: info.size },
    async read(signal, maxBytes) {
      await assertUnchanged(ctx, target, info, signal)
      const bytes = await ctx.fs.readBytes(target, signal, maxBytes).catch((cause: unknown) => {
        if (codeOf(cause) !== 'FS_TOO_LARGE') throw cause
        throw new OfficeKitError('input-too-large', 'The source exceeds the reserved byte capacity.', { cause })
      })
      await assertUnchanged(ctx, target, info, signal)
      return { bytes, version: info.version }
    },
  }
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/** Model-facing failure for a classified Office service error; other failures pass through unchanged. */
function officeFailure(verb: string, path: string, error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== 'OfficeKitError') return error
  const hint = codeOf(error) === 'busy' ? ' Retry after other document operations finish.'
    : codeOf(error) === 'output-too-large' && verb === 'render' ? ' Select fewer pages, a smaller range, or a lower dpi.' : ''
  return new Error(`cannot ${verb} "${path}": ${error.message}${hint}`, { cause: error })
}

async function render(
  ctx: Context, kit: OfficeKit, config: Config, exec: ToolExecution, args: OfficeArgs, target: FsTarget, source: OfficeKitSource,
): Promise<OfficeRenderValue> {
  const path = ctx.fs.processPath(target)
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error(`cannot render "${target.displayPath}": no attachment service is mounted`)
  await assertImageInputRoute(ctx, exec, {
    unresolved: `cannot render "${target.displayPath}": the current model route could not be resolved`,
    unsupported: model => `cannot render "${target.displayPath}": model "${model}" does not accept images`,
  })
  const limits = attachments.imageLimits
  let result
  try {
    result = await kit.renderImages({
      // `inputFamily` admitted the extension.
      extension: extensionOf(args.input) as Parameters<OfficeKit['renderImages']>[0]['extension'],
      priority: 'foreground', source,
      ...args.pages === undefined ? {} : { pages: args.pages },
      ...args.sheet === undefined ? {} : { sheet: args.sheet },
      ...args.range === undefined ? {} : { range: args.range },
      ...args.dpi === undefined ? {} : { dpi: args.dpi },
      maxImages: Math.min(config.maxImages, limits.maxImagesPerMessage),
      maxPixels: Math.min(config.maxImagePixels, limits.maxImagePixels),
      maxDimension: Math.min(config.maxImageDimension, limits.maxImageDimension),
      maxBytes: Math.min(config.maxImageBytes, limits.maxMessageImageBytes),
    }, exec.signal)
  } catch (error) { throw officeFailure('render', target.displayPath, error) }
  const oversized = result.images.find(image => image.png.byteLength > limits.maxImageBytes)
  if (oversized !== undefined) {
    throw new Error(`cannot render "${target.displayPath}": an image exceeds the ${limits.maxImageBytes}-byte image limit; select a smaller range or a lower dpi`)
  }
  const stem = basename(target.displayPath)
  let refs: readonly ImageAttachmentRef[]
  try {
    refs = await attachments.saveImages(result.images.map((image, index) => ({
      data: image.png, mediaType: 'image/png' as const, name: `${stem}-${index + 1}.png`,
    })))
  } catch (error) {
    if (!attachments.isAttachmentError(error)) throw error
    throw new Error(`cannot render "${target.displayPath}": ${error.message}`, { cause: error })
  }
  return {
    operation: 'render', path, pageCount: result.pageCount, dpi: result.dpi, missingFonts: result.missingFonts,
    images: result.images.map((image, index) => {
      // saveImages returns one reference per input, in input order.
      const ref = refs[index] as ImageAttachmentRef
      return {
        ...image.page === undefined ? {} : { page: image.page },
        ...image.sheet === undefined ? {} : { sheet: image.sheet },
        ...image.range === undefined ? {} : { range: image.range },
        attachmentId: ref.attachmentId, mediaType: 'image/png', bytes: ref.bytes, width: ref.width, height: ref.height,
        ...ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } },
      }
    }),
  }
}

/**
 * Output-store owner for a conversion: the root Session of the caller's subagent tree, so a subagent's output stays
 * until the conversation that delegated it ends. Without the `subagents` service every Agent is its own root.
 */
function outputOwner(ctx: Context, exec: ToolExecution): string {
  if (exec.agent === undefined) return 'agentless'
  return (ctx.get('subagents')?.rootOf(exec.agent) ?? exec.agent).session.id
}

async function convertFile(
  ctx: Context, kit: OfficeKit, exec: ToolExecution, args: OfficeArgs, family: Exclude<OfficeFamily, 'pdf'>,
  target: FsTarget, source: OfficeKitSource,
): Promise<OfficeFileValue> {
  const operation = args.operation as 'convert' | 'recalculate'
  // `checkArguments` requires format for convert and recalculate.
  const format = args.format as string
  checkOutputFormat(operation, family, target.displayPath, format)
  if (ctx.fs.processPathFromHostPath(kit.outputDirectory) === undefined) {
    throw new Error(`cannot ${operation} "${target.displayPath}": converted files are not available when the workspace is on a remote host`)
  }
  const extension = extensionOf(args.input)
  const stem = basename(target.displayPath).replace(/\.[^.]*$/u, '')
  const output = { owner: outputOwner(ctx, exec), name: `${stem}.${format}` }
  let result
  try {
    result = operation === 'convert'
      ? await kit.convertTo({
        // `inputFamily` and `checkOutputFormat` admitted both extensions.
        extension: extension as Parameters<OfficeKit['convertTo']>[0]['extension'],
        format: format as Parameters<OfficeKit['convertTo']>[0]['format'],
        ...args.sheet === undefined ? {} : { sheet: args.sheet },
        priority: 'foreground', source, output,
      }, exec.signal)
      : await kit.recalculate({
        extension: extension as Parameters<OfficeKit['recalculate']>[0]['extension'],
        format: format as Parameters<OfficeKit['recalculate']>[0]['format'],
        priority: 'foreground', source, output,
      }, exec.signal)
  } catch (error) { throw officeFailure(operation, target.displayPath, error) }
  return {
    operation, path: ctx.fs.processPath(target),
    // The output directory check above established that this execution world reads Host files.
    file: ctx.fs.processPathFromHostPath(result.path) as string,
    format, bytes: result.bytes,
    ...result.pageCount === undefined ? {} : { pageCount: result.pageCount },
    missingFonts: result.missingFonts,
  }
}
