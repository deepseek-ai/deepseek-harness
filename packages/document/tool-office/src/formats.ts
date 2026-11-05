/**
 * Office document families, accepted formats, and input-dependent argument rules.
 * @module @deepseek-ai/dsh-tool-office/formats
 */

import type { OfficeConversionFormat, OfficeRecalculationFormat } from '@deepseek-ai/dsh-office-kit'

/** Operation requested by one Office tool call. */
export type OfficeOperationName = 'render' | 'convert' | 'recalculate'

/** Document family selected by an input extension. */
export type OfficeFamily = 'text' | 'spreadsheet' | 'presentation' | 'pdf'

const FAMILIES: Readonly<Record<string, OfficeFamily>> = {
  doc: 'text', docx: 'text', odt: 'text',
  xls: 'spreadsheet', xlsx: 'spreadsheet', ods: 'spreadsheet',
  ppt: 'presentation', pptx: 'presentation', odp: 'presentation',
  pdf: 'pdf',
}

/** Conversion outputs per input family. */
export const CONVERSION_OUTPUTS: Readonly<Record<Exclude<OfficeFamily, 'pdf'>, readonly OfficeConversionFormat[]>> = {
  text: ['pdf', 'docx', 'odt', 'txt'],
  spreadsheet: ['pdf', 'xlsx', 'ods', 'csv'],
  presentation: ['pdf', 'pptx', 'odp'],
}

/** Every conversion or recalculation output format. */
export const OUTPUT_FORMATS = ['pdf', 'docx', 'odt', 'txt', 'xlsx', 'ods', 'csv', 'pptx', 'odp'] as const satisfies readonly OfficeConversionFormat[]

/** Every recalculation output format. */
export const RECALCULATION_FORMATS = ['xlsx', 'ods'] as const satisfies readonly OfficeRecalculationFormat[]

/** Arguments for rendering document pages or worksheet areas. */
export interface OfficeRenderArgs {
  input: string
  pages?: number[]
  sheet?: string
  range?: string
  dpi?: number
}

/** Arguments for converting a document. */
export interface OfficeConvertArgs {
  input: string
  format: OfficeConversionFormat
  sheet?: string
}

/** Arguments for recalculating a workbook. */
export interface OfficeRecalculateArgs {
  input: string
  format: OfficeRecalculationFormat
}

/** Model-facing Office tool name. */
export type OfficeToolName = 'office_render' | 'office_convert' | 'office_recalculate'

/**
 * Refuse argument keys the called tool does not declare, because the open parameter object would otherwise ignore
 * them; a key that another Office tool declares names that tool.
 * @param tool - called tool.
 * @param args - call arguments.
 * @param declared - parameter names of every Office tool.
 * @throws Error naming the undeclared key and the Office tools that accept it.
 */
export function checkParameterNames(
  tool: OfficeToolName, args: object, declared: Readonly<Record<OfficeToolName, readonly string[]>>,
): void {
  for (const key of Object.keys(args)) {
    if (declared[tool].includes(key)) continue
    const owners = (Object.keys(declared) as OfficeToolName[]).filter(other => declared[other].includes(key))
    throw new Error(owners.length === 0 ? `${tool} does not accept ${key}` : `${key} applies only to ${owners.join(' or ')}`)
  }
}

/**
 * Lowercase file extension of a path without its dot.
 * @param path - resolved or model-supplied path.
 * @returns the extension, or an empty string when the name has none.
 */
export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Select the document family of an input for one operation.
 * @param operation - requested operation.
 * @param path - input path whose extension names the format.
 * @returns the family the operation accepts.
 * @throws Error naming the accepted formats when the operation does not accept this input.
 */
export function inputFamily(operation: OfficeOperationName, path: string): OfficeFamily {
  const extension = extensionOf(path)
  const family = FAMILIES[extension]
  if (operation === 'recalculate') {
    if (family !== 'spreadsheet') throw new Error(`cannot recalculate "${path}": recalculate accepts xls, xlsx, or ods workbooks`)
    return family
  }
  if (family === undefined || (family === 'pdf' && operation === 'convert')) {
    const accepted = operation === 'render' ? 'doc, docx, odt, xls, xlsx, ods, ppt, pptx, odp, or pdf' : 'doc, docx, odt, xls, xlsx, ods, ppt, pptx, or odp'
    throw new Error(`cannot ${operation} "${path}": ${operation} accepts ${accepted} files`)
  }
  return family
}

/**
 * Check render selections that the tool schema subset cannot express.
 * @param args - schema-validated call arguments.
 * @param family - input family selected by {@link inputFamily}.
 * @throws Error naming the misplaced or malformed argument.
 */
export function checkRenderArguments(args: OfficeRenderArgs, family: OfficeFamily): void {
  if (args.pages !== undefined) {
    if (family === 'spreadsheet') throw new Error('pages does not apply to spreadsheets; select sheet and range instead')
    if (args.pages.length === 0 || args.pages.some(page => !Number.isSafeInteger(page) || page < 1)
      || new Set(args.pages).size !== args.pages.length) {
      throw new Error('pages must list distinct one-based page numbers')
    }
  }
  if (family !== 'spreadsheet' && args.sheet !== undefined) throw new Error('sheet applies only to spreadsheets')
  if (args.range !== undefined && args.sheet === undefined) throw new Error('range requires sheet')
  if (args.sheet !== undefined && args.sheet.trim() === '') throw new Error('sheet must be an exact worksheet name')
  if (args.dpi !== undefined && (!Number.isSafeInteger(args.dpi) || args.dpi < 24 || args.dpi > 600)) {
    throw new Error('dpi must be an integer from 24 to 600')
  }
}

/**
 * Check conversion formats and worksheet selection against the input family.
 * @param args - schema-validated conversion arguments.
 * @param family - input family.
 * @throws Error naming the formats available for this input.
 */
export function checkConversionArguments(args: OfficeConvertArgs, family: Exclude<OfficeFamily, 'pdf'>): void {
  const accepted = CONVERSION_OUTPUTS[family]
  if (!accepted.includes(args.format)) {
    throw new Error(`cannot convert "${args.input}" to ${args.format}: this file converts to ${accepted.join(', ')}`)
  }
  if (args.sheet !== undefined && args.format !== 'csv') throw new Error('sheet applies only to CSV conversion')
  if (args.sheet !== undefined && args.sheet.trim() === '') throw new Error('sheet must be an exact worksheet name')
}
