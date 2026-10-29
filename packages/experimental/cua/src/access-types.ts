/** Client-safe Computer Use permission observations and saved application decisions. */
import type { CuaApplicationGrant } from './application-types.ts'
import type { ApplicationDragReference } from '@deepseek-ai/dsh-util-file-drag'
export type { CuaApplicationGrant, CuaApplicationId } from './application-types.ts'

/** macOS privileges used by the native provider. */
export type CuaSystemPermission = 'accessibility' | 'screenRecording'
/** Observed process; neither the helper nor its parent is assumed to be the TCC owner. */
export interface CuaPermissionProcess {
  pid: number
  path?: string | undefined
  name?: string | undefined
}
/** Fresh permission observations and startup metadata from the shared native helper. */
export interface CuaSystemPermissionState {
  accessibility: boolean
  screenRecording: boolean
  helper: CuaPermissionProcess
  parent: CuaPermissionProcess
  /** Application macOS reports as responsible for the helper, captured at startup; absent when it cannot be identified. */
  launchApplication?: {
    name: string
    path: string
    icon?: string | undefined
    bundleId?: string | undefined
    dragReference?: ApplicationDragReference | undefined
  } | undefined
  /** Bounds for permission-only checks while the user follows the authorization guide. */
  guidancePolling: { intervalMs: number; timeoutMs: number }
}
/** Saved grants and refused applications, independent of native permission checks and icons. */
export interface CuaApplicationState {
  allowedApps: readonly CuaApplicationGrant[]
  /** Refusals from any session, excluding saved grants; other sessions may still hold session access. */
  blockedApps: readonly CuaApplicationGrant[]
  persistentAvailable: boolean
}
