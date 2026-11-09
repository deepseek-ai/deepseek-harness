/** Image values carried by program bindings and explicit inspection output. */
import type { PtcJsonValue } from './types.ts'

/** A stored image readable from the program's execution environment. */
export class PtcImage {
  readonly [key: string]: PtcJsonValue
  /** Absolute attachment file path readable in the execution world. */
  readonly path: string
  /** Stored pixel width. */
  readonly width: number
  /** Stored pixel height. */
  readonly height: number

  /**
   * Describe one immutable image file in the execution world.
   * @param path - Absolute path to the stored image.
   * @param width - Stored pixel width.
   * @param height - Stored pixel height.
   */
  constructor(path: string, width: number, height: number) {
    this.path = path
    this.width = width
    this.height = height
    Object.freeze(this)
  }
}

/** One inspected image positioned among captured text entries. */
export interface PtcImageOutput {
  /** Number of text entries emitted before this image. */
  afterLog: number
  /** Host-issued image selected by the program. */
  image: PtcImage
}
