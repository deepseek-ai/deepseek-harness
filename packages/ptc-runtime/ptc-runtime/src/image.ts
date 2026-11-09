/** Image values carried by program bindings and explicit inspection output. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PtcJsonValue } from './types.ts'

/** A stored image readable from the program's execution environment. */
export class PtcImage {
  readonly [key: string]: PtcJsonValue
  /** Absolute attachment file path readable in the execution world. */
  readonly path: string
  /** Stored image selected when the program inspects this value. */
  readonly attachment: Readonly<ImageAttachmentRef>

  /**
   * Describe one immutable image file in the execution world.
   * @param path - Absolute path to the stored image.
   * @param attachment - Reference to the immutable stored image.
   */
  constructor(path: string, attachment: ImageAttachmentRef) {
    this.path = path
    this.attachment = attachment
    Object.freeze(this)
  }
}
