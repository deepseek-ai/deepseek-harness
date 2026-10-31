/**
 * Office document families, accepted operation formats, and argument rules of the `office` tool.
 * @module @deepseek-ai/dsh-tool-office/formats
 */

/** Operation requested by one `office` call. */
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
export const CONVERSION_OUTPUTS: Readonly<Record<Exclude<OfficeFamily, 'pdf'>, readonly string[]>> = {
  text: ['pdf', 'docx', 'odt', 'txt'],
  spreadsheet: ['pdf', 'xlsx', 'ods', 'csv'],
  presentation: ['pdf', 'pptx', 'odp'],
}

/** Recalculation outputs. */
export const RECALCULATION_OUTPUTS: readonly string[] = ['xlsx', 'ods']

/** Every conversion or recalculation output format. */
export const OUTPUT_FORMATS = ['pdf', 'docx', 'odt', 'txt', 'xlsx', 'ods', 'csv', 'pptx', 'odp'] as const

/** Validated arguments of one `office` call. */
export interface OfficeArgs {
  operation: OfficeOperationName
  input: string
  format?: string
  pages?: number[]
  sheet?: string
  range?: string
  dpi?: number
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
 * Check the arguments that apply to the requested operation and input family.
 * @param args - schema-validated call arguments.
 * @param family - input family selected by {@link inputFamily}.
 * @throws Error naming the misplaced or malformed argument.
 */
export function checkArguments(args: OfficeArgs, family: OfficeFamily): void {
  const misplaced = (name: string, scope: string): Error => new Error(`${name} applies only to ${scope}`)
  if (args.operation === 'render') {
    if (args.format !== undefined) throw misplaced('format', 'convert and recalculate')
  } else {
    if (args.format === undefined) throw new Error(`${args.operation} requires format`)
    if (args.pages !== undefined) throw misplaced('pages', 'render')
    if (args.range !== undefined) throw misplaced('range', 'render')
    if (args.dpi !== undefined) throw misplaced('dpi', 'render')
    if (args.sheet !== undefined && (args.operation === 'recalculate' || args.format !== 'csv')) {
      throw misplaced('sheet', 'render and CSV conversion')
    }
  }
  if (args.pages !== undefined) {
    if (family === 'spreadsheet') throw new Error('pages does not apply to spreadsheets; select sheet and range instead')
    if (args.pages.length === 0 || args.pages.some(page => !Number.isSafeInteger(page) || page < 1)
      || new Set(args.pages).size !== args.pages.length) {
      throw new Error('pages must list distinct one-based page numbers')
    }
  }
  if (args.operation === 'render' && family !== 'spreadsheet' && args.sheet !== undefined) throw misplaced('sheet', 'spreadsheets')
  if (args.range !== undefined && args.sheet === undefined) throw new Error('range requires sheet')
  if (args.sheet !== undefined && args.sheet.trim() === '') throw new Error('sheet must be an exact worksheet name')
  if (args.dpi !== undefined && (!Number.isSafeInteger(args.dpi) || args.dpi < 24 || args.dpi > 600)) {
    throw new Error('dpi must be an integer from 24 to 600')
  }
}

/**
 * Check the output format of a conversion or recalculation.
 * @param operation - `convert` or `recalculate`.
 * @param family - input family.
 * @param input - input path named in the refusal.
 * @param format - requested output format.
 * @throws Error naming the formats available for this input.
 */
export function checkOutputFormat(
  operation: Exclude<OfficeOperationName, 'render'>, family: Exclude<OfficeFamily, 'pdf'>, input: string, format: string,
): void {
  const accepted = operation === 'recalculate' ? RECALCULATION_OUTPUTS : CONVERSION_OUTPUTS[family]
  if (!accepted.includes(format)) {
    throw new Error(`cannot ${operation} "${input}" to ${format}: this file ${operation === 'recalculate' ? 'recalculates' : 'converts'} to ${accepted.join(', ')}`)
  }
}
