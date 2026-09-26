/** Localizable rejections shared by profile management operations. */
import type { PluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import type { IncompatiblePlugin, ManagementError } from './types.ts'

/** Expected management rejection; presentation belongs to the caller's locale. */
export class ManagementFailure extends Error {
  /** Code rendered by the caller's locale dictionary. */
  readonly code: ManagementError['code']
  /** The packages an `incompatible-version` rejection names. */
  readonly incompatible: IncompatiblePlugin[] | undefined
  /**
   * @param code Localizable management rejection.
   * @param incompatible Packages the running DSH version rejects, for `incompatible-version`.
   */
  constructor(code: ManagementError['code'], incompatible?: IncompatiblePlugin[]) {
    super(code)
    this.code = code
    this.incompatible = incompatible
  }
}

/**
 * Drop the exemption status from an unexempted compatibility result.
 * @param issue Result whose exemption is not active.
 * @returns The package, runtime, and rejected peer ranges.
 */
export function incompatiblePlugin(issue: PluginCompatibility): IncompatiblePlugin {
  return { name: issue.name, version: issue.version, runtimeVersion: issue.runtimeVersion, peers: issue.peers }
}
