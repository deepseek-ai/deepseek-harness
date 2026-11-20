/** Opaque Trajectory focus identity for one model request. */

const REQUEST_FOCUS_PREFIX = 'request\u0000'

/**
 * Encode one model request as a Trajectory focus identity.
 * @param turn - owning turn number.
 * @param step - step number of the request within its turn.
 * @returns the opaque focus identity.
 */
export function requestFocus(turn: number, step: number): string {
  return `${REQUEST_FOCUS_PREFIX}${turn}\u0000${step}`
}

/**
 * Read a focus identity produced by {@link requestFocus}.
 * @param focus - focus identity addressed to the Trajectory view.
 * @returns the addressed request, or null when the focus addresses something else or is malformed.
 */
export function parseRequestFocus(focus: string): { readonly turn: number; readonly step: number } | null {
  if (!focus.startsWith(REQUEST_FOCUS_PREFIX)) return null
  const [turn, step] = focus.slice(REQUEST_FOCUS_PREFIX.length).split('\u0000')
  if (turn === undefined || step === undefined) return null
  const parsedTurn = Number(turn)
  const parsedStep = Number(step)
  return Number.isInteger(parsedTurn) && Number.isInteger(parsedStep)
    ? { turn: parsedTurn, step: parsedStep }
    : null
}
