/** Immutable version identity shared by one Electron shell and its dsh seed. */

import { valid } from 'semver'
import { DESKTOP_HOST_PROTOCOL_VERSION } from './host-protocol.ts'

/** Release facts embedded in the seed and copied into the active desktop project. */
export interface DesktopRelease {
  readonly schemaVersion: 1
  /** Exact version used by both Electron and `@deepseek-ai/dsh`. */
  readonly version: string
  readonly hostProtocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly nodeVersion: string
  readonly pnpmVersion: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Validate release data read from an installed or packaged filesystem resource. */
export function parseDesktopRelease(value: unknown): DesktopRelease {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.version !== 'string'
    || valid(value.version) === null || value.hostProtocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION
    || typeof value.nodeVersion !== 'string' || valid(value.nodeVersion) === null
    || typeof value.pnpmVersion !== 'string' || valid(value.pnpmVersion) === null) {
    throw new Error('dsh desktop: invalid desktop release metadata')
  }
  return {
    schemaVersion: 1,
    version: value.version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: value.nodeVersion,
    pnpmVersion: value.pnpmVersion,
  }
}
