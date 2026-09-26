/** Required deployment-selected metadata for mandatory-update policy requests. */
export interface DesktopPolicyEnvironment {
  origin: string
  allowedPageOrigins: string[]
  allowedAuthOrigins?: string[]
  authentication: 'anonymous' | 'feishu-test'
  [key: string]: unknown
}

/**
 * Resolve policy settings before artifact preparation or signing.
 * @param environment File-owned release settings; only the selected origin is required.
 * @returns Policy metadata with deployment-selected origin and authentication.
 */
export function resolveDesktopPolicyEnvironment(environment: NodeJS.ProcessEnv): DesktopPolicyEnvironment
