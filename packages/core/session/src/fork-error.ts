/** Typed rejection errors for session forking. */

/**
 * Rejection codes for session forking: the fork source id is unknown to the
 * live store (`SESSION_NOT_FOUND`) or names a session object that is not the
 * store's live instance (`SESSION_NOT_LIVE`); the requested child id is
 * already taken (`SESSION_ALREADY_EXISTS`); or the boundary is not a contiguous
 * existing seq (`INVALID_BOUNDARY`).
 */
export type SessionForkErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_LIVE'
  | 'SESSION_ALREADY_EXISTS'
  | 'INVALID_BOUNDARY'

/** Typed error for session fork rejections. */
export class SessionForkError extends Error {
  constructor(message: string, public readonly code: SessionForkErrorCode) {
    super(message)
    this.name = 'SessionForkError'
  }
}
