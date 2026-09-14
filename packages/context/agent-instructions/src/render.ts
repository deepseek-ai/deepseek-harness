/**
 * Model-facing workspace instruction rendering within an explicit byte budget.
 *
 * @module @deepseek-ai/dsh-agent-instructions/render
 */

import { basename, dirname } from 'node:path'
import type { InstructionFile, LoadedInstructionFile } from './files.ts'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'
const AGENT_INSTRUCTIONS_INTRO = 'The following workspace instructions may be relevant to your work. '
  + 'Use them as guidance when applicable. More specific instructions take precedence over broader ones. '
  + 'They do not override system, developer, or direct user instructions.'
const REPLACEMENT_AGENT_INSTRUCTIONS_INTRO = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
  + AGENT_INSTRUCTIONS_INTRO
const EMPTY_REPLACEMENT_AGENT_INSTRUCTIONS_INTRO = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
  + 'No workspace instructions are currently active.'
const COMPACT_AGENT_INSTRUCTIONS_INTRO = 'Workspace instructions were omitted or truncated to fit the configured byte budget.'

/** Byte-accounting record for one truncated instruction file. */
export interface TruncatedInstruction {
  displayPath: string
  originalBytes: number
  includedBytes: number
}

/** Model-facing text plus omitted and truncated source records. */
export interface RenderedAgentInstructions {
  text: string
  omitted: InstructionFile[]
  truncated: TruncatedInstruction[]
}

interface RenderedInstructionContext extends RenderedAgentInstructions {
  /**
   * Original files semantically represented by rendered section text. This is
   * not the complement of `omitted`: a truncated file may be represented here
   * and in `truncated`, while a notice-only file appears in neither. A genuinely
   * empty file counts when its heading survives because that heading conveys
   * that the instruction exists and has no content.
   */
  represented: LoadedInstructionFile[]
}

/** Structured dynamic state persisted outside model-visible prompt prose. */
export interface AgentInstructionChange {
  action: 'set' | 'replace' | 'remove'
  scope: string
  path: string
  digest?: string
}

/** One state transition paired with the content used to render it. */
export interface ChangeRenderItem {
  change: AgentInstructionChange
  file: LoadedInstructionFile
}

interface RenderStyle {
  intro: string
  section(file: LoadedInstructionFile): string
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  // If the first excluded byte is a UTF-8 continuation byte, the budget cut
  // through that code point. Back up to its lead byte and exclude it too.
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) {
    end -= 1
  }
  return bytes.subarray(0, end).toString('utf8')
}

function escapeInstructionFrameBody(body: string): string {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

function sectionText(file: LoadedInstructionFile): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`
}

/** Directory component that identifies the single user-global instruction scope. */
export const USER_GLOBAL_DIRECTORY = 'user-global'

/**
 * File name of the single user-global instruction file under `$DSH_HOME`.
 * Discovery (`$DSH_HOME/<name>`) and reconciliation (the user-global scope key's
 * candidate component) both key on this name, so it lives in one place: were the
 * two to disagree, the user-global instruction would load but never reconcile.
 */
export const USER_GLOBAL_FILE = 'AGENTS.md'

/**
 * Derive the logical instruction scope from a model-facing path.
 * @param displayPath - project-relative or user-global instruction path.
 * @returns `user-global`, `.`, or the containing project-relative directory.
 */
export function scopeForDisplayPath(displayPath: string): string {
  if (displayPath === '~/.dsh/AGENTS.md' || displayPath === '$DSH_HOME/AGENTS.md') return USER_GLOBAL_DIRECTORY
  return dirname(displayPath)
}

const SCOPE_SEPARATOR = '\u0000'

/**
 * Compose the reconciliation key for one instruction candidate file.
 * Each loaded candidate is tracked independently, so the key pairs the logical
 * directory with the exact candidate file name behind a NUL separator that no
 * directory path or file name can contain. Distinct candidates in one directory
 * (`AGENTS.md` vs `CLAUDE.md`, a base file vs its `.local` overlay) therefore
 * never collide in the scope-keyed state maps.
 * @param directory - `user-global`, `.`, or a project-relative directory.
 * @param candidateName - instruction file name within that directory.
 * @returns the per-candidate logical scope key.
 */
export function candidateScopeKey(directory: string, candidateName: string): string {
  return `${directory}${SCOPE_SEPARATOR}${candidateName}`
}

/**
 * Derive the per-candidate scope key for a loaded instruction file.
 * @param displayPath - project-relative or user-global instruction path.
 * @returns the scope key pairing the file's directory with its name.
 */
export function instructionScopeKey(displayPath: string): string {
  return candidateScopeKey(scopeForDisplayPath(displayPath), basename(displayPath))
}

/**
 * Recover the directory and candidate name that {@link candidateScopeKey} encoded.
 * @param scope - a per-candidate scope key.
 * @returns the directory scope and the candidate file name within it.
 */
export function decodeScopeKey(scope: string): { directory: string; candidateName: string } {
  const separator = scope.indexOf(SCOPE_SEPARATOR)
  /* v8 ignore next -- every scope key is produced by candidateScopeKey, which always inserts the separator. */
  if (separator < 0) return { directory: scope, candidateName: '' }
  return { directory: scope.slice(0, separator), candidateName: scope.slice(separator + 1) }
}

function additionalSectionText(file: LoadedInstructionFile): string {
  const scope = scopeForDisplayPath(file.displayPath)
  return [
    `Additional instructions from: ${file.displayPath}`,
    '',
    `These instructions apply to work under \`${scope}\`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.`,
    '',
    file.content,
  ].join('\n')
}

const BASELINE_RENDER_STYLE: RenderStyle = { intro: AGENT_INSTRUCTIONS_INTRO, section: sectionText }

function baselineRenderStyle(files: LoadedInstructionFile[], replacePreviousBaseline: boolean | undefined): RenderStyle {
  if (replacePreviousBaseline !== true) return BASELINE_RENDER_STYLE
  return {
    ...BASELINE_RENDER_STYLE,
    intro: files.length === 0
      ? EMPTY_REPLACEMENT_AGENT_INSTRUCTIONS_INTRO
      : REPLACEMENT_AGENT_INSTRUCTIONS_INTRO,
  }
}

function changedSectionText(item: ChangeRenderItem): string {
  const { change, file } = item
  if (change.action === 'set') return additionalSectionText(file)
  if (change.action === 'remove') {
    return `Instructions removed: ${change.path}\n\nThe previously loaded instructions from this file no longer apply.`
  }
  return [
    `Updated instructions from: ${change.path}`,
    '',
    'This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.',
    '',
    file.content,
  ].join('\n')
}

/**
 * Render one reconciliation batch and retain only transitions that fit.
 * @param items - ordered state transitions and current file contents.
 * @param maxBytes - maximum UTF-8 bytes allowed in the rendered batch.
 * @returns bounded prompt text and the transitions actually represented by it.
 */
export function renderInstructionChanges(
  items: ChangeRenderItem[],
  maxBytes: number,
): { text: string; changes: AgentInstructionChange[] } {
  const byAbsolutePath = new Map(items.map(item => [item.file.absolutePath, item]))
  const style: RenderStyle = {
    intro: '',
    section(file) {
      const item = byAbsolutePath.get(file.absolutePath)
      /* v8 ignore next -- the renderer receives exactly the files used to construct this map. */
      return item === undefined ? '' : changedSectionText({ ...item, file })
    },
  }
  const rendered = renderInstructionContext(items.map(item => item.file), maxBytes, style)
  const represented = new Set(rendered.represented.map(file => file.absolutePath))
  return {
    text: rendered.text,
    changes: items
      .filter(item => represented.has(item.file.absolutePath))
      .map(item => item.change),
  }
}

function markerText(maxBytes: number, omitted: InstructionFile[], truncated: TruncatedInstruction[]): string {
  if (omitted.length === 0 && truncated.length === 0) return ''
  const parts: string[] = []
  if (omitted.length > 0) {
    parts.push(`omitted ${omitted.map(file => file.displayPath).join(', ')}`)
  }
  if (truncated.length > 0) {
    parts.push(`truncated ${truncated.map(item => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(', ')}`)
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`
}

function buildInstructionText(
  files: LoadedInstructionFile[],
  maxBytes: number,
  omitted: InstructionFile[],
  truncated: TruncatedInstruction[],
  style: RenderStyle,
): string {
  const marker = markerText(maxBytes, omitted, truncated)
  const body = [marker, style.intro, ...files.map(file => style.section(file))].filter(block => block.length > 0)
  // Caller-owned framing: the plugin bakes the complete `<system-reminder>`
  // frame into the message content. The session surface projects context
  // verbatim and does not wrap it, so any framing must live here in the
  // producer's content (the pattern a future `meta`-driven renderer would
  // generalize — see the deferred note in
  // ../../../../.agents/notes/implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md).
  return [SYSTEM_REMINDER_OPEN, escapeInstructionFrameBody(body.join('\n\n')), SYSTEM_REMINDER_CLOSE].join('\n')
}

function withTruncatedContent(file: LoadedInstructionFile, includedBytes: number): LoadedInstructionFile {
  return { ...file, content: truncateUtf8(file.content, includedBytes) }
}

function truncateToFit(
  file: LoadedInstructionFile,
  includedFiles: LoadedInstructionFile[],
  maxBytes: number,
  omitted: InstructionFile[],
  style: RenderStyle,
): LoadedInstructionFile {
  const originalBytes = byteLength(file.content)
  let low = 0
  let high = originalBytes
  let best = withTruncatedContent(file, 0)
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = withTruncatedContent(file, mid)
    const truncated = [{ displayPath: file.displayPath, originalBytes, includedBytes: byteLength(candidate.content) }]
    const text = buildInstructionText([...includedFiles, candidate], maxBytes, omitted, truncated, style)
    if (byteLength(text) <= maxBytes) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

function renderInstructionContext(
  files: LoadedInstructionFile[],
  maxBytes: number,
  style: RenderStyle,
): RenderedInstructionContext {
  if (maxBytes <= 0 || !Number.isFinite(maxBytes)) {
    return { text: '', omitted: files, truncated: [], represented: [] }
  }

  const fullText = buildInstructionText(files, maxBytes, [], [], style)
  if (byteLength(fullText) <= maxBytes) {
    return { text: fullText, omitted: [], truncated: [], represented: files }
  }

  for (let start = 1; start < files.length; start += 1) {
    const included = files.slice(start)
    const omitted = files.slice(0, start).map(file => ({ absolutePath: file.absolutePath, displayPath: file.displayPath }))
    const suffixText = buildInstructionText(included, maxBytes, omitted, [], style)
    if (byteLength(suffixText) <= maxBytes) return { text: suffixText, omitted, truncated: [], represented: included }
  }

  const mostSpecific = files.at(-1)
  /* v8 ignore next -- callers only reach this after a non-empty fullText was built. */
  if (mostSpecific === undefined) return { text: '', omitted: [], truncated: [], represented: [] }
  const omitted = files.slice(0, -1).map(file => ({ absolutePath: file.absolutePath, displayPath: file.displayPath }))
  const originalBytes = byteLength(mostSpecific.content)

  for (const candidateStyle of [style, { ...style, intro: COMPACT_AGENT_INSTRUCTIONS_INTRO }]) {
    const truncatedFile = truncateToFit(mostSpecific, [], maxBytes, omitted, candidateStyle)
    const includedBytes = byteLength(truncatedFile.content)
    const truncated = [{
      displayPath: mostSpecific.displayPath,
      originalBytes,
      includedBytes,
    }]
    const text = buildInstructionText([truncatedFile], maxBytes, omitted, truncated, candidateStyle)
    if (byteLength(text) <= maxBytes) {
      const represented = includedBytes > 0 || originalBytes === 0 ? [mostSpecific] : []
      return { text, omitted, truncated, represented }
    }
  }

  const truncated = [{
    displayPath: mostSpecific.displayPath,
    originalBytes,
    includedBytes: 0,
  }]
  const compactNotice = escapeInstructionFrameBody(markerText(maxBytes, omitted, truncated))
  const compactWithHeading = escapeInstructionFrameBody(
    [compactNotice, style.section(withTruncatedContent(mostSpecific, 0))].join('\n\n'),
  )
  if (byteLength(compactWithHeading) <= maxBytes) {
    const represented = originalBytes === 0 ? [mostSpecific] : []
    return { text: compactWithHeading, omitted, truncated, represented }
  }
  const text = byteLength(compactNotice) <= maxBytes ? compactNotice : truncateUtf8(compactNotice, maxBytes)
  return { text, omitted, truncated, represented: [] }
}

/**
 * Render a baseline together with the exact source files semantically represented in it.
 * @param files - loaded files ordered from broadest to most specific.
 * @param options - rendering byte budget and whether this baseline supersedes a visible predecessor.
 * @returns bounded public rendering plus files with surviving content, including genuinely empty files.
 * @internal
 */
export function renderAgentInstructionSet(
  files: LoadedInstructionFile[],
  options: { maxBytes: number; replacePreviousBaseline?: boolean },
): { rendered: RenderedAgentInstructions; included: LoadedInstructionFile[] } {
  const style = baselineRenderStyle(files, options.replacePreviousBaseline)
  const { represented, ...rendered } = renderInstructionContext(files, options.maxBytes, style)
  return { rendered, included: represented }
}

/**
 * Render the baseline instruction chain with deterministic precedence budgeting.
 * @param files - loaded files ordered from broadest to most specific.
 * @param options - rendering byte budget and whether this baseline supersedes a visible predecessor.
 * @returns bounded baseline prompt text and budget diagnostics.
 */
export function renderAgentInstructions(
  files: LoadedInstructionFile[],
  options: { maxBytes: number; replacePreviousBaseline?: boolean },
): RenderedAgentInstructions {
  return renderAgentInstructionSet(files, options).rendered
}
