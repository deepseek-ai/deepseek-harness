/** Structured binding values with host-authored text for explicit inspection. */
import type { PtcJsonValue } from './types.ts'

/** A binding result whose unchanged object or array displays the supplied text when inspected directly. */
export class PtcInspectableValue {
  readonly [key: string]: PtcJsonValue
  /** The JSON object or array delivered unchanged to the program. */
  readonly value: PtcJsonValue[] | { [key: string]: PtcJsonValue }
  /** Text shown by a direct inspection of the unchanged value; empty text emits nothing. */
  readonly text: string

  /**
   * Associate an object or array with its host-authored inspection text.
   * @param value - Lossless JSON data retained for programmatic access.
   * @param text - Text to display instead of generic object formatting.
   */
  constructor(value: PtcJsonValue[] | { [key: string]: PtcJsonValue }, text: string) {
    this.value = value
    this.text = text
    Object.freeze(this)
  }
}
