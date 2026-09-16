/** Localizable rejections shared by profile management operations. */
import type { ManagementError } from './types.ts'

/** Expected management rejection; presentation belongs to the caller's locale. */
export class ManagementFailure extends Error {
  /** Code rendered by the caller's locale dictionary. */
  readonly code: ManagementError['code']
  /** @param code Localizable management rejection. */
  constructor(code: ManagementError['code']) { super(code); this.code = code }
}
