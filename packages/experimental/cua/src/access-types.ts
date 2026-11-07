/** Client-safe Computer Use permission observations and saved application decisions. */
import type { CuaApplicationGrant } from './application-types.ts'
export type { CuaApplicationGrant, CuaApplicationId } from './application-types.ts'

/** macOS privileges used by the native provider. */
export type CuaSystemPermission = 'accessibility' | 'screenRecording'
/** Observed process; neither the helper nor its parent is assumed to be the TCC owner. */
export interface CuaPermissionProcess {
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
  helper: CuaPermissionProcess
}
/** Saved grants and refused applications, independent of native permission checks and icons. */
export interface CuaApplicationState {
  allowedApps: readonly CuaApplicationGrant[]
  /** Refusals from any session, excluding saved grants; other sessions may still hold session access. */
  blockedApps: readonly CuaApplicationGrant[]
  persistentAvailable: boolean
}
