/** LibreOffice selection callbacks retain native twip coordinates for client overlays; every parsed `Rect` is in twips. */
import type { Rect } from '../types.ts'

/**
 * Decode the geometry prefix of an invalidation, caret, or text-selection callback.
 * @param payload - Comma-separated twip coordinates, optionally followed by callback metadata.
 * @returns The first finite rectangle, or undefined when geometry is missing or malformed.
 */
export function parseCallbackRectangle(payload: string): Rect | undefined {
  const values = payload.split(',').slice(0, 4).map(Number)
  const [x, y, width, height] = values
  if (x === undefined || y === undefined || width === undefined || height === undefined
    || values.some(value => !Number.isFinite(value))) return undefined
  return { x, y, width, height }
}

function integer(value: unknown): number | undefined {
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) value = Number(value)
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function fields(payload: string, count: number): number[] | undefined {
  const values = payload.split(',').map(integer)
  if (values.length !== count || !values.every((value): value is number => value !== undefined)) return undefined
  return values
}

function rectangle(values: number[]): Rect | undefined {
  const [x, y, width, height] = values
  if (x === undefined || y === undefined || width === undefined || height === undefined || width < 0 || height < 0)
    return undefined
  return { x, y, width, height }
}

/**
 * Decode the cell cursor independently of the text caret.
 * @param payload - Callback 17's six comma-separated integers: rectangle, column and row.
 * @returns The twip rectangle, or undefined for EMPTY or malformed input.
 */
export function parseCellCursor(payload: string): Rect | undefined {
  const values = fields(payload, 6)
  if (!values || values.slice(4).some(value => value < 0)) return undefined
  return rectangle(values)
}

/**
 * Decode graphic bounds; trailing JSON properties describe editing handles and are ignored.
 * @param payload - Callback 6's rectangle, rotation angle and optional JSON properties.
 * @returns Twip bounds, or undefined for EMPTY or malformed input.
 */
export function parseGraphicSelection(payload: string): Rect | undefined {
  const jsonStart = payload.indexOf('{')
  let prefix = jsonStart < 0 ? payload : payload.slice(0, jsonStart).trimEnd()
  if (jsonStart >= 0) {
    if (!prefix.endsWith(',')) return undefined
    prefix = prefix.slice(0, -1)
  }
  const values = fields(prefix, 5)
  return values && rectangle(values)
}
