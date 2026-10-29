/**
 * What a forked child may actually do, decided per request rather than per session.
 *
 * A ceiling that is only a list of settings is not a limit: the child would run with the owner's
 * tools and only be asked not to use them. This decides each attempted tool use against the installed
 * ceiling, so the permitted set is what a child can do — read inside the bounded workspace — and
 * everything that could reach the owner's machine, session, permissions, or another child is refused
 * by name.
 */

import type { ForkCeiling } from './fork-policy.ts'

/** One tool use a child is attempting. */
export interface ForkToolRequest {
  /** Child session attempting the use. */
  readonly childSessionId: string
  /** Session the requesting page holds, which must be that child. */
  readonly sessionId: string
  /** Tool name as the harness knows it. */
  readonly tool: string
}

/** Stable refusals a child's tool use can receive. */
export type ForkToolRefusal =
  | 'fork-ceiling-uninstalled'
  | 'fork-tool-not-permitted'
  | 'fork-child-mismatch'
  /** A path argument leaves the workspace this child was granted. */
  | 'fork-path-outside-workspace'
  /** The tool's paths could not be established, so nothing could be authorized. */
  | 'fork-paths-unknown'

/** Outcome of one tool-use decision. */
export type ForkToolDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ForkToolRefusal; readonly message: string }

/**
 * Decide one tool use by a forked child.
 * @param ceiling Ceiling installed on this host, or undefined when none is.
 * @param request The attempted use.
 * @returns Allowed, or the named reason it is refused.
 */
export function forkToolDecision(
  ceiling: ForkCeiling | undefined,
  request: ForkToolRequest,
): ForkToolDecision {
  if (ceiling === undefined) {
    return {
      ok: false,
      code: 'fork-ceiling-uninstalled',
      message: 'read-only execution limits are not installed on this host',
    }
  }
  // The page may only use the tools of the child it holds: one child reaching into another, or into
  // the source session, is the crossing this refuses.
  if (request.sessionId !== request.childSessionId) {
    return {
      ok: false,
      code: 'fork-child-mismatch',
      message: 'this session is not the fork this tool use came from',
    }
  }
  if (!ceiling.allowedTools.includes(request.tool)
    || ceiling.deniedCapabilities.includes(request.tool)) {
    return {
      ok: false,
      code: 'fork-tool-not-permitted',
      message: `a fork may not use ${request.tool}`,
    }
  }
  return { ok: true }
}
