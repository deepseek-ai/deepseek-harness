/**
 * Model-facing Office tools render document pages, convert documents, and recalculate workbooks through the shared
 * `officeKit` service. Tools are admitted after an Office skill loads; a missing service makes admitted calls fail
 * as `unavailable`. Reads use the filesystem backend's read authority; each call reads
 * one source byte before the service runs, so a cached result never answers a call that cannot read the source.
 * Converted files stay in the Office kit's private output store; the model copies them into the workspace with the
 * shell, so these tools write no workspace file.
 * @module @deepseek-ai/dsh-tool-office
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-llm'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-skill'
import { OfficeKitError, OfficeSourceKey, type OfficeDocumentExtension, type OfficeImageInputExtension, type OfficeKit,
  type OfficeKitSource, type OfficeWorkbookExtension } from '@deepseek-ai/dsh-office-kit'
import { defineTool, type ToolActivationContext, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { checkParameterNames, checkRenderArguments, checkConversionArguments, extensionOf, inputFamily, OUTPUT_FORMATS,
  RECALCULATION_FORMATS,
  type OfficeRenderArgs, type OfficeConvertArgs, type OfficeRecalculateArgs, type OfficeFamily, type OfficeOperationName,
  type OfficeToolName } from './formats.ts'
import { renderFileContent, renderImagesContent, type OfficeFileFormats, type OfficeFileValue,
  type OfficeRenderValue } from './content.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-office'

/** Required services; `officeKit` is read at each call, and `attachments` and `llm` are checked when rendering. */
export const inject = ['tools', 'fs', 'workingDirectory', 'agents']

/** Activation skills and render bounds; lower deployment attachment limits take precedence. */
export interface Config {
  /** Skill names whose successful loading admits all three tools from the following step. */
  activationSkills: string[]
  /** Maximum images one render returns, including worksheet fragments. */
  maxImages: number
  /** Maximum pixels of each image. */
  maxImagePixels: number
  /** Maximum width and height of each image in pixels. */
  maxImageDimension: number
  /** Maximum PNG bytes across all images of one render. */
  maxImageBytes: number
}

/** Validated activation skills and render bounds. */
export const Config: z<Partial<Config>, Config> = z.object({
  activationSkills: z.array(z.string().pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).min(1)
    .default(['office', 'office-docx', 'office-xlsx', 'office-pptx']),
  maxImages: z.natural().min(1).max(10_000).default(20),
  maxImagePixels: z.natural().min(1).max(16_777_216).default(8_388_608),
  maxImageDimension: z.natural().min(1).max(16_777_216).default(8192),
  maxImageBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(32 * 1024 * 1024),
})

/** Stored encodings of a rendered PNG: attachment normalization keeps it or re-encodes it as JPEG or WebP. */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const satisfies readonly ImageMediaType[]

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer' },
    sheet: { type: 'string' },
    range: { type: 'string' },
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: IMAGE_MEDIA_TYPES, required: true },
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
const OFFICE_TOOL_NAMES: readonly string[] = ['office_render', 'office_convert', 'office_recalculate']

const RENDER_PARAMETERS = {
  input: { type: 'string', required: true, description: 'Path to doc, docx, odt, xls, xlsx, ods, ppt, pptx, odp, or pdf; not modified.' },
  pages: {
    type: 'array', items: { type: 'integer' },
    description: 'Distinct one-based pages or slides; omit for all. Spreadsheets use sheet and range instead.',
  },
  sheet: {
    type: 'string',
    description: 'Exact worksheet name; omit to render every visible sheet.',
  },
  range: { type: 'string', description: 'A1 range, such as A1:H40; requires sheet. Omit for the used area.' },
  dpi: { type: 'integer', description: 'Resolution from 24 to 600; default 144.' },
} as const

const CONVERT_PARAMETERS = {
  input: { type: 'string', required: true, description: 'Path to doc, docx, odt, xls, xlsx, ods, ppt, pptx, or odp; not modified.' },
  format: {
    type: 'string', required: true, enum: OUTPUT_FORMATS,
    description: 'Word: pdf, docx, odt, txt. Excel: pdf, xlsx, ods, csv. PowerPoint: pdf, pptx, odp.',
  },
  sheet: { type: 'string', description: 'Exact worksheet name for CSV only; required when the workbook has several sheets.' },
} as const

const RECALCULATE_PARAMETERS = {
  input: { type: 'string', required: true, description: 'Path to an xls, xlsx, or ods workbook; not modified.' },
  format: { type: 'string', required: true, enum: RECALCULATION_FORMATS, description: 'Output workbook format.' },
} as const

const PARAMETER_NAMES: Readonly<Record<OfficeToolName, readonly string[]>> = {
  office_render: Object.keys(RENDER_PARAMETERS),
  office_convert: Object.keys(CONVERT_PARAMETERS),
  office_recalculate: Object.keys(RECALCULATE_PARAMETERS),
}

/** Output definition of a file-producing `operation` whose `format` is one of `formats`. */
function fileOutput<const Operation extends 'convert' | 'recalculate', const Formats extends readonly string[]>(operation: Operation, formats: Formats) {
  return {
    schema: { type: 'object', additionalProperties: false, properties: {
      operation: { type: 'string', const: operation, required: true },
      path: { type: 'string', required: true, description: 'Canonical absolute input path.' },
      file: { type: 'string', required: true, description: 'Absolute path of the temporary output file.' },
      format: { type: 'string', required: true, enum: formats },
      bytes: { type: 'integer', required: true },
      pageCount: { type: 'integer', description: 'Page count the converter reports for the output.' },
      missingFonts: MISSING_FONTS_SCHEMA,
    } },
    render: (_args: unknown, value: OfficeFileValue<Operation>) => renderFileContent(value),
    presentationMeta: (_args: unknown, value: OfficeFileValue<Operation>) => ({ path: value.path, file: value.file }),
  } as const
}

/**
 * Register Office tools admitted after a successful skill load or an earlier Office declaration.
 * @param ctx - registration scope; disposing it removes the tools.
 * @param config - validated activation skills and render bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const skills = new Set(config.activationSkills)
  const marked = new WeakSet<Agent>()
  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined || exec.name !== 'skill' || result.isError) return
    const args = exec.arguments
    if (typeof args === 'object' && args !== null && 'name' in args && typeof args.name === 'string' && skills.has(args.name)) {
      marked.add(exec.agent)
    }
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'skill-invocation' || !skills.has(event.data.source.name)) return
    const agent = ctx.agents.get(session.id)
    if (agent?.session === session) marked.add(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => { marked.delete(agent) })
  // Native request headers retain these declarations across resume and fork. PTC headers contain only run_code;
  // after losing the in-memory mark, a PTC agent must load an Office skill again.
  const when = ({ agent }: ToolActivationContext): boolean => marked.has(agent)
    || agent.session.requestHeader()?.tools?.some(tool => OFFICE_TOOL_NAMES.includes(tool.name)) === true
  ctx.tools.register(defineTool({
    name: 'office_render',
    description: 'Render document pages, slides, or worksheet areas as images you can view.',
    parameters: RENDER_PARAMETERS,
    output: {
      schema: {
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
      render: (_args, value) => renderImagesContent(value),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<OfficeRenderValue> {
      checkParameterNames('office_render', args, PARAMETER_NAMES)
      checkRenderArguments(args, inputFamily('render', args.input))
      const { agent, kit, target, source } = await prepareInput(ctx, exec, 'render', args.input)
      return render(ctx, kit, config, agent, exec.signal, args, target, source)
    },
    presentCall: args => ({ card: 'generic', title: `Render ${args.input}`, kind: 'read', locations: [{ path: args.input }] }),
  }), { when })
  ctx.tools.register(defineTool({
    name: 'office_convert',
    description: 'Convert a document to another format. Return a temporary file to copy to its destination with the shell.',
    parameters: CONVERT_PARAMETERS,
    output: fileOutput('convert', OUTPUT_FORMATS),
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<OfficeFileValue<'convert'>> {
      checkParameterNames('office_convert', args, PARAMETER_NAMES)
      // `inputFamily` rejects PDF for convert and recalculate.
      checkConversionArguments(args, inputFamily('convert', args.input) as Exclude<OfficeFamily, 'pdf'>)
      const { agent, kit, target, source } = await prepareInput(ctx, exec, 'convert', args.input)
      return convertFile(ctx, kit, agent, exec.signal, 'convert', args, target, source)
    },
    presentCall: args => ({ card: 'generic', title: `Convert ${args.input} to ${args.format}`, kind: 'other', locations: [{ path: args.input }] }),
  }), { when })
  ctx.tools.register(defineTool({
    name: 'office_recalculate',
    description: 'Recalculate spreadsheet formulas. Return a temporary workbook to copy to its destination with the shell.',
    parameters: RECALCULATE_PARAMETERS,
    output: fileOutput('recalculate', RECALCULATION_FORMATS),
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<OfficeFileValue<'recalculate'>> {
      checkParameterNames('office_recalculate', args, PARAMETER_NAMES)
      inputFamily('recalculate', args.input)
      const { agent, kit, target, source } = await prepareInput(ctx, exec, 'recalculate', args.input)
      return convertFile(ctx, kit, agent, exec.signal, 'recalculate', args, target, source)
    },
    presentCall: args => ({ card: 'generic', title: `Recalculate ${args.input}`, kind: 'other', locations: [{ path: args.input }] }),
  }), { when })
}

/**
 * Resolve the calling Agent and the current Office service, then authorize the read before a cache lookup. A missing
 * service fails before any filesystem access.
 */
async function prepareInput(ctx: Context, exec: ToolExecution, operation: OfficeOperationName, input: string) {
  const { agent, signal } = exec
  // Conditional registrations execute only through a step tool set, which the calling Agent resolves.
  if (agent === undefined) throw new Error(`cannot ${operation} "${input}": Office tools run only in an Agent step`)
  const kit = ctx.get('officeKit')
  if (kit === undefined) {
    throw officeFailure(operation, input, new OfficeKitError('unavailable', 'The document converter is unavailable.'))
  }
  const cwd = await ctx.workingDirectory.ensure(agent, signal)
  const { target, info } = await readableInput(ctx, input, { cwd, signal })
  try {
    await authorizeContent(ctx, target, info, signal)
  } catch (error) { throw officeFailure(operation, target.displayPath, error) }
  return { agent, kit, target, source: officeSource(ctx, agent, target, info) }
}

/** Resolve an input through the filesystem backend and require a regular file. */
async function readableInput(
  ctx: Context, path: string, options: { cwd: string; signal: AbortSignal },
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
function officeSource(ctx: Context, agent: Agent, target: FsTarget, info: FsInfo): OfficeKitSource {
  return {
    key: OfficeSourceKey(JSON.stringify([agent.session.id, ctx.fs.processPath(target)])),
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
  if (!(error instanceof OfficeKitError)) return error
  const hint = error.code === 'unavailable'
    ? ' Tell the user this operation is unavailable, or retry later if the cause may be temporary; do not substitute system soffice, npx, or another converter.'
    : error.code === 'busy' ? ' Retry after other document operations finish.'
      : error.code === 'output-too-large' && verb === 'render' ? ' Select fewer pages, a smaller range, or a lower dpi.' : ''
  return new Error(`cannot ${verb} "${path}": ${error.message}${hint}`, { cause: error })
}

/**
 * Require the calling model route to declare image input. The route is the Session's latest request header
 * configuration, falling back to the agent options; a model whose capability is unknown is refused.
 */
async function assertRenderRoute(ctx: Context, agent: Agent, signal: AbortSignal, displayPath: string): Promise<void> {
  const llm = ctx.get('llm')
  const header = agent.session.requestHeader()?.config
  const model = header?.model ?? agent.options.model
  const provider = header?.provider ?? agent.options.provider
  if (llm === undefined || provider === undefined || model === undefined) {
    throw new Error(`cannot render "${displayPath}": the current model route could not be resolved`)
  }
  const { inputModalities = [] } = await llm.resolveModelInfo(provider, model, signal)
  if (!inputModalities.includes('image')) throw new Error(`cannot render "${displayPath}": model "${model}" does not accept images`)
}

async function render(
  ctx: Context, kit: OfficeKit, config: Config, agent: Agent, signal: AbortSignal, args: OfficeRenderArgs, target: FsTarget,
  source: OfficeKitSource,
): Promise<OfficeRenderValue> {
  const path = ctx.fs.processPath(target)
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error(`cannot render "${target.displayPath}": no attachment service is mounted`)
  await assertRenderRoute(ctx, agent, signal, target.displayPath)
  const limits = attachments.imageLimits
  let result
  try {
    result = await kit.renderImages({
      // `inputFamily` admitted the extension.
      extension: extensionOf(args.input) as OfficeImageInputExtension,
      source,
      ...args.pages === undefined ? {} : { pages: args.pages },
      ...args.sheet === undefined ? {} : { sheet: args.sheet },
      ...args.range === undefined ? {} : { range: args.range },
      ...args.dpi === undefined ? {} : { dpi: args.dpi },
      maxImages: Math.min(config.maxImages, limits.maxImagesPerMessage),
      maxPixels: Math.min(config.maxImagePixels, limits.maxImagePixels),
      maxDimension: Math.min(config.maxImageDimension, limits.maxImageDimension),
      maxBytes: Math.min(config.maxImageBytes, limits.maxMessageImageBytes),
    }, signal)
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
      const { mediaType } = ref
      // Normalization of a PNG yields PNG, JPEG, or WebP.
      if (mediaType === 'image/gif') throw new Error(`cannot render "${target.displayPath}": the attachment service stored a rendered PNG as GIF`)
      return {
        ...image.page === undefined ? {} : { page: image.page },
        ...image.sheet === undefined ? {} : { sheet: image.sheet },
        ...image.range === undefined ? {} : { range: image.range },
        attachmentId: ref.attachmentId, mediaType, bytes: ref.bytes, width: ref.width, height: ref.height,
        ...ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } },
      }
    }),
  }
}

/**
 * Output-store owner for a conversion: the root Session of the caller's subagent tree, so a subagent's output stays
 * until the conversation that delegated it ends. Without the `subagents` service every Agent is its own root, and a
 * caller whose tree root is already disposed owns its output itself.
 */
function outputOwner(ctx: Context, agent: Agent): string {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) return agent.session.id
  try {
    return subagents.rootOf(agent).session.id
  } catch (error) {
    // A disposed tree root can no longer release outputs; the calling Session releases them instead.
    if (error instanceof SubagentError && error.code === 'UNAUTHORIZED') return agent.session.id
    throw error
  }
}

async function convertFile<Operation extends 'convert' | 'recalculate'>(
  ctx: Context, kit: OfficeKit, agent: Agent, signal: AbortSignal, operation: Operation,
  args: (OfficeConvertArgs | OfficeRecalculateArgs) & { format: OfficeFileFormats[Operation] },
  target: FsTarget, source: OfficeKitSource,
): Promise<OfficeFileValue<Operation>> {
  const { format } = args
  if (ctx.fs.processPathFromHostPath(kit.outputDirectory) === undefined) {
    throw new Error(`cannot ${operation} "${target.displayPath}": converted files are not available when the workspace is on a remote host`)
  }
  const extension = extensionOf(args.input)
  const stem = basename(target.displayPath).replace(/\.[^.]*$/u, '')
  const output = { owner: outputOwner(ctx, agent), name: `${stem}.${format}` }
  let result
  try {
    result = operation === 'convert'
      ? await kit.convertTo({
        // `inputFamily` and `checkConversionArguments` admitted both extensions.
        extension: extension as OfficeDocumentExtension,
        format,
        ...'sheet' in args ? { sheet: args.sheet } : {},
        source, output,
      }, signal)
      : await kit.recalculate({
        extension: extension as OfficeWorkbookExtension,
        // The office_recalculate schema admitted only recalculation formats.
        format: format as OfficeRecalculateArgs['format'],
        source, output,
      }, signal)
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
