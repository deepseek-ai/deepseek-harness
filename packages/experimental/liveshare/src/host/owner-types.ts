/**
 * The share record the owner host persists and every extracted owner module reads.
 *
 * The type lives apart from the plugin assembly so the persistence, Relay authority, HTTP, and
 * supervision modules do not import the assembly they are wired into.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/owner-types
 */

import type { ShareAccessSelection } from '../share-api-types.ts'
import type { ViewerSessionMode } from './fork-policy.ts'
import type { ViewerCapabilityGroup } from './viewer-declarations.ts'

/** The ACL one share carried when it was stored, as both the loader and the owner view read it. */
export interface ShareAccessSummary {
  /**
   * Mode this share was created with. A state file written before the allowlist mode was renamed
   * from `approval` still carries that spelling, so the stored plane admits it and the loader maps
   * it to {@link OwnerShare}'s vocabulary; every wire and registration surface refuses it.
   */
  readonly mode: 'open' | 'selected' | 'approval'
  readonly selected: readonly ShareAccessSelection[]
  readonly deploymentAllowedSubjectIds: readonly string[]
  readonly shareAllowedSubjectIds: readonly string[]
  readonly broadenedByDeploymentSubjects: boolean
  readonly identityKeyAcl: true
}

/** One share this host keeps in its owner state, as the worker and the client both read it. */
export interface OwnerShare {
  readonly shareId: string
  readonly sessionId: string
  readonly sessionTitle: string
  readonly accessMode: 'open' | 'selected'
  readonly link: string
  /** Relay base URL this share was published to; an owner override never rewrites existing shares. */
  readonly relay: string
  readonly gatewayToken: string
  readonly allowedSubjectIds: readonly string[]
  readonly access?: ShareAccessSummary
  readonly revision: number
  readonly createdAt: string
  /** ISO time after which the Relay denies viewers; absent means the share never expires. */
  readonly expiresAt?: string
  /**
   * Whether an admitted viewer may fork this share; false unless the owner turned it on.
   *
   * Independent of the tier: forking is its own switch, so a view-tier share may allow it and a
   * writable one may refuse it.
   */
  allowsFork: boolean
  /**
   * Which of the two tiers this share carries, as the owner chose it.
   *
   * `view` reads the source session and drives its loop inside the granted workspace without writing
   * it; `write` also modifies the files inside that workspace.
   */
  sessionMode: ViewerSessionMode
  /**
   * Plugin endpoints this share exposes to its viewers, grouped by declaring plugin.
   *
   * Absent means the owner exposed none: the endpoints plugins offer stay refused. A selection grants
   * nothing on its own — the `share-viewer` policy intersects it with the plugin's live declaration.
   */
  readonly viewerCapabilities?: readonly ViewerCapabilityGroup[]
  online: boolean
}
