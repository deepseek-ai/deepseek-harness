/**
 * The `file` protocol's resource metadata, navigation params, Client errors,
 * and internal change-feed notices.
 */
// Bring the base `ResourceProtocolMap` declaration into this program so the
// augmentation below merges into it instead of declaring a second interface.
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type { WorkspaceFileStat } from '../types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /**
     * One workspace file's metadata, addressed as
     * `dsh-resource://file/session/<sessionId>/<path>` (absolute or workspace-relative).
     */
    file: WorkspaceFileStat
  }
}

/** What a `file` tab is asked to reveal on open or navigation; JSON-shaped. */
export interface WorkspaceFileParams {
  /** 1-based line to scroll into view; absent leaves the position alone. */
  readonly line?: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * The address is not a `dsh-resource://file/` address in a scope the
     * provider recognizes: `session/<sessionId>/<path>` or
     * `absolute/<absolute path>`. Raised by the Client provider; the Host never
     * emits it.
     */
    'workspace-file/unsupported-address': { readonly address: string }
    /**
     * An `absolute` address has no Session to authorize its Host call.
     * Raised by the Client provider; the Host never emits it. Session addresses
     * are resolved by the Host without a Client Session summary.
     */
    'workspace-file/unknown-workspace': { readonly address: string }
  }
}

/** One Host-reported write inside the session's workspace. */
export type WorkspaceFileEdit =
  | { readonly kind: 'changed'; readonly version: string }
  | { readonly kind: 'absent' }

/** What one follower of a path receives: a Host write. */
export type WorkspaceFileNotice = WorkspaceFileEdit
