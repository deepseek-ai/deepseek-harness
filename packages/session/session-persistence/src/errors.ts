/**
 * Stable failures exposed by the session-persistence service and its handles,
 * including the format refusals shared by every backend: a stored log this
 * build cannot faithfully interpret is refused, never misread, and the
 * refusal points at the raw artifact when the backend keeps one per session.
 * @module @deepseek-ai/dsh-session-persistence/errors
 */

import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** The requested Session identity has no durable log visible to this caller. */
export class SessionPersistenceNotFoundError extends Error {
  /** @param sessionId - absent durable Session identity. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" not found`)
    this.name = 'SessionPersistenceNotFoundError'
  }
}

/** `create` targeted a Session identity that already exists in this backend. */
export class SessionAlreadyExistsError extends Error {
  /** @param sessionId - the occupied durable Session identity. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" already exists`)
    this.name = 'SessionAlreadyExistsError'
  }
}

/** A write open found the session already bound to an active write handle. */
export class SessionAlreadyOwnedError extends Error {
  /** @param sessionId - the session whose write ownership is taken. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is already owned by an active write handle`)
    this.name = 'SessionAlreadyOwnedError'
  }
}

/** A mutation (`append`/`flush`) was called on a read handle. */
export class SessionReadOnlyError extends Error {
  /**
   * @param sessionId - the session the read handle observes.
   * @param operation - the refused mutating operation name.
   */
  constructor(readonly sessionId: SessionId, operation: string) {
    super(`session "${sessionId}": ${operation} is not available on a read handle`)
    this.name = 'SessionReadOnlyError'
  }
}

/**
 * A write handle's ownership is permanently gone: its lease expired, a renewal
 * failed, or the durable ownership record no longer names this handle. The
 * handle never re-acquires ownership — close it and reopen for write.
 *
 * Declared for the cross-process lease layer; the shipped in-process backends
 * never throw it yet.
 */
export class SessionOwnershipLostError extends Error {
  /** @param sessionId - the session whose write ownership this handle lost. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}": write ownership was lost; close this handle and reopen`)
    this.name = 'SessionOwnershipLostError'
  }
}

/** An operation was called on a handle after `close()` was called. */
export class SessionHandleClosedError extends Error {
  /**
   * @param sessionId - the session the closed handle addressed.
   * @param operation - the refused operation name.
   */
  constructor(readonly sessionId: SessionId, operation: string) {
    super(`session "${sessionId}": ${operation} on a closed handle`)
    this.name = 'SessionHandleClosedError'
  }
}

/**
 * A backend-resolved, per-session local artifact location. Carried only by
 * refusal diagnostics ({@link SessionFormatUnsupportedError}) so a user can
 * find the raw log a build refused to interpret; it is not a consumer-facing
 * query — log access goes through a session handle's `read`.
 */
export interface SessionLocation {
  /** Backend-specific artifact kind, for example `jsonl`. */
  readonly kind: string
  /** Absolute path to this session's backend-owned artifact. */
  readonly path: string
}

/** Durable session contents failed validation after a successful backend read. */
export class SessionPersistenceCorruptionError extends Error {
  /**
   * @param message - stable corruption context.
   * @param options - original validation failure.
   */
  constructor(message: string, options: ErrorOptions) {
    super(message, options)
    this.name = 'SessionPersistenceCorruptionError'
  }
}

/**
 * The stored log is intact but this runtime cannot faithfully interpret it:
 * the header carries an unsupported format version, or an event's type is
 * unknown to this build. Distinct from {@link SessionPersistenceCorruptionError}
 * — nothing is damaged; the raw log remains readable at {@link location} when
 * the backend keeps one artifact per session.
 */
export class SessionFormatUnsupportedError extends Error {
  /**
   * @param message - stable reason the log cannot be interpreted, already
   *   including the raw-log path when one exists.
   * @param location - the backend's artifact location, when one exists.
   */
  constructor(message: string, readonly location?: SessionLocation) {
    super(message)
    this.name = 'SessionFormatUnsupportedError'
  }
}

/**
 * Direction-aware refusal text for a stored session whose format version this
 * build does not read. Shared by load-time checks and by backends that must
 * refuse BEFORE decoding version-dependent structure (a future format may not
 * satisfy this build's structural checks at all, and the user must see
 * "upgrade the harness", never "corrupt").
 * @param id - the stored session id, for message context.
 * @param version - the stored format version.
 * @returns the stable refusal text, without a raw-log path suffix.
 */
export function sessionFormatVersionRefusal(id: string, version: number): string {
  return version > SESSION_FORMAT_VERSION
    ? `session "${id}" uses log format v${version}, but this harness reads only v${SESSION_FORMAT_VERSION}: the log was written by a newer harness — upgrade the harness to open it`
    : `session "${id}" uses log format v${version}, older than the supported v${SESSION_FORMAT_VERSION}, and this build ships no upgrade path for it`
}
