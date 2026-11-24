/** Client-safe Computer Use permission observations and saved application decisions. */
import type { CuaApplicationGrant } from './application-types.ts'
export type { CuaApplicationGrant, CuaApplicationId } from './application-types.ts'

/** macOS privileges used by the native provider. */
export type CuaSystemPermission = 'accessibility' | 'screenRecording'
/** Observed macOS process; the helper and its parent may differ from the TCC owner. */
export interface CuaPermissionProcess {
  pid: number
  path?: string | undefined
  name?: string | undefined
}
/** Native access observations tagged with the provider's CUA platform; distinct from Node process.platform values. */
export type CuaSystemPermissionState = {
  platform: 'darwin'
  accessibility: boolean
  screenRecording: boolean
  helper: CuaPermissionProcess
  parent: CuaPermissionProcess
  /** Application macOS reports as responsible for the helper, captured at startup; absent when it cannot be identified. */
  launchApplication?: { name: string; path: string; icon?: string | undefined } | undefined
} | {
  platform: 'windows'
  sessionLocked: boolean | null
  captureAvailable: boolean
  elevated: boolean
  helper: Omit<CuaPermissionProcess, 'pid'>
}
/** Saved grants and refused applications, independent of native permission checks and icons. */
export interface CuaApplicationState {
  allowedApps: readonly CuaApplicationGrant[]
  /** Refusals from any session, excluding saved grants; other sessions may still hold session access. */
  blockedApps: readonly CuaApplicationGrant[]
  /** Obsolete saved identities that cannot authorize the current provider; absent when none require review. */
  reviewApps?: readonly CuaApplicationGrant[] | undefined
  persistentAvailable: boolean
}

/** Provider classification of saved identities that require renewed consent. */
export interface CuaApplicationReview {
  /** Identify obsolete grants using stored fields without native discovery.
   * @param application Saved application identity and presentation.
   * @returns Whether this identity requires fresh consent under the provider's current identity rules.
   */
  needsReview(application: CuaApplicationGrant): boolean
}
