/** Read replayable PTC source and language hints from recorded tool arguments and schemas. */
import type { TrajectoryCellProps } from './trajectory-record.ts'

/** Recorded name of the programmatic tool-calling entry point. */
export const PTC_TOOL_NAME = 'run_code'

/** Validated source and original arguments for one recorded run_code call. */
export interface CodeProgram {
  rawInput: string
  source: string
  description: string
  arguments: Record<string, unknown>
  language: 'typescript' | 'python' | undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  try {
    return record(JSON.parse(value))
  } catch {
    return undefined
  }
}

function recordedLanguage(schemaRaw: string | undefined): CodeProgram['language'] {
  const schema = parseRecord(schemaRaw)
  const properties = record(record(schema?.parameters)?.properties)
  const description = record(properties?.code)?.description
  if (typeof description !== 'string') return undefined
  const typescript = /\bTypeScript\b/i.test(description)
  const python = /\bPython\b/i.test(description)
  if (typescript === python) return undefined
  return typescript ? 'typescript' : 'python'
}

/**
 * Resolve a PTC program without guessing its language from source or current runtime settings.
 * @param cell - Recorded tool arguments and the schema visible at call time.
 * @returns The program, or undefined for another tool or unsupported arguments.
 */
export function codeProgram(cell: TrajectoryCellProps): CodeProgram | undefined {
  if (cell.kind !== 'tool' && cell.kind !== 'subtool') return undefined
  if (cell.toolName !== PTC_TOOL_NAME || cell.inputDetail === undefined) return undefined
  const args = parseRecord(cell.inputDetail)
  if (typeof args?.code !== 'string') return undefined
  if (args.description !== undefined && typeof args.description !== 'string') return undefined
  return {
    rawInput: cell.inputDetail,
    source: args.code,
    description: typeof args.description === 'string' && args.description.trim() !== ''
      ? args.description
      : args.code.split(/\r?\n/).find(line => line.trim() !== '')?.trim() ?? '',
    arguments: args,
    language: recordedLanguage(cell.schemaDetail),
  }
}
