/** Display formatting for the Statistics table. */

/** Placeholder for a value the event stream did not record. */
export const DASH = '—'

/** Whether a value is a finite number. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Duration: minutes past one minute, seconds past one second, milliseconds below.
 * @param value - duration in milliseconds.
 * @returns formatted duration, or the dash placeholder.
 */
export function formatMs(value: number | null): string {
  if (!isNumber(value)) return DASH
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)} min`
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)} s` : `${Math.round(value)} ms`
}

/**
 * Token count with thousands separators, for tooltips.
 * @param value - token count.
 * @returns grouped digits, or the dash placeholder.
 */
export function formatTokens(value: number | null): string {
  if (!isNumber(value)) return DASH
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Token count in K, switching to M once the value reaches ten million.
 * @param value - token count, or null when unrecorded.
 * @returns the K/M-suffixed count, or the dash placeholder.
 */
export function formatTokensShort(value: number | null): string {
  if (!isNumber(value)) return DASH
  if (value >= 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : `${(value / 1_000).toFixed(2)}K`
}

/**
 * Signed context delta, using the same K scale as the counts it belongs to.
 * @param value - token delta; null produces an empty string.
 * @returns signed K-suffixed delta.
 */
export function formatTokensDelta(value: number | null): string {
  if (!isNumber(value)) return ''
  return `${value >= 0 ? '+' : '−'}${formatTokensShort(Math.abs(value))}`
}

/**
 * Character count of tool output, collapsed to K past one thousand.
 * @param value - character count.
 * @returns formatted size, or the dash placeholder.
 */
export function formatChars(value: number | null): string {
  if (!isNumber(value) || value <= 0) return DASH
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(Math.round(value))
}

/**
 * Output speed in tokens per second.
 * @param value - tokens per second.
 * @returns one-decimal speed, or the dash placeholder.
 */
export function formatTps(value: number | null): string {
  return isNumber(value) ? `${value.toFixed(1)} tok/s` : DASH
}

/**
 * Share as a two-decimal percentage.
 * @param value - share in [0, 1].
 * @returns percentage text, or the dash placeholder.
 */
export function formatPercent(value: number | null): string {
  return isNumber(value) ? `${(value * 100).toFixed(2)}%` : DASH
}

/**
 * Local wall-clock time of day, so a row lines up with logs.
 * @param value - epoch milliseconds.
 * @returns `HH:MM:SS`, or the dash placeholder.
 */
export function formatClock(value: number | null): string {
  if (!isNumber(value)) return DASH
  const date = new Date(value)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Compact month-day clock for the turn scope cell; tooltips carry the full date.
 * @param value - epoch milliseconds.
 * @returns `MM-DD HH:MM`, or the dash placeholder.
 */
export function formatDateTimeShort(value: number | null): string {
  if (!isNumber(value)) return DASH
  const date = new Date(value)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Local timestamp: full date or month-day, seconds, and optional milliseconds. */
function formatStamp(value: number | null, fullDate: boolean, millis: boolean): string {
  if (!isNumber(value)) return DASH
  const date = new Date(value)
  const pad = (part: number, width = 2): string => String(part).padStart(width, '0')
  const day = fullDate
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${day} ${clock}${millis ? `.${pad(date.getMilliseconds(), 3)}` : ''}`
}

/**
 * Full timestamp with milliseconds for tooltips.
 * @param value - epoch milliseconds.
 * @returns `YYYY-MM-DD HH:MM:SS.mmm`, or the dash placeholder.
 */
export function formatDateTimeMs(value: number | null): string {
  return formatStamp(value, true, true)
}

/**
 * Step start timestamp with date and milliseconds for the trigger column.
 * @param value - epoch milliseconds.
 * @returns `MM-DD HH:MM:SS.mmm`, or the dash placeholder.
 */
export function formatStepClock(value: number | null): string {
  return formatStamp(value, false, true)
}

/**
 * Date and time of day: the table shows the clock, tooltips add the date.
 * @param value - epoch milliseconds.
 * @returns `YYYY-MM-DD HH:MM:SS`, or the dash placeholder.
 */
export function formatDateTime(value: number | null): string {
  return formatStamp(value, true, false)
}

/**
 * Bar length on a square-root scale: a linear scale collapses short steps into
 * slivers, and a logarithmic one flattens the differences the column exists to
 * show. The longest member of the comparison group fills the bar.
 * @param total - measured duration.
 * @param scale - longest duration of the comparison group.
 * @returns fill share in [0, 1].
 */
export function barShare(total: number, scale: number): number {
  if (!isNumber(scale) || scale <= 0) return 1
  if (total <= 0) return 0
  return Math.min(1, Math.sqrt(total / scale))
}
