/**
 * Error identities the registry records on failed tool results. The values are
 * persisted contract; the entry does not re-export them, and consumers compare
 * the recorded strings.
 * @module
 */

/** Error name the registry records when approval does not grant a call. */
export const APPROVAL_ERROR_NAME = 'ApprovalError'

/** Approval code for a call the user rejected. */
export const APPROVAL_REJECTED = 'APPROVAL_REJECTED'

/** Approval code for an approval request cancelled without a caller cancellation. */
export const APPROVAL_CANCELLED = 'APPROVAL_CANCELLED'

/** Approval code for a call that needs approval when no approval service, Agent, or channel can answer it. */
export const APPROVAL_UNAVAILABLE = 'APPROVAL_UNAVAILABLE'

/** One code an approval denial records under {@link APPROVAL_ERROR_NAME}. */
export type ApprovalErrorCode = typeof APPROVAL_REJECTED | typeof APPROVAL_CANCELLED | typeof APPROVAL_UNAVAILABLE

/** Code of `ToolContextUnavailableError`. */
export const TOOL_CONTEXT_UNAVAILABLE = 'TOOL_CONTEXT_UNAVAILABLE'
