/** Workspace settings relevant to exact local build approvals. */
export interface RuntimeDeployConfig {
  readonly allowBuilds?: Readonly<Record<string, boolean | string>>
  readonly [setting: string]: unknown
}

/** Pnpm configuration hooks scoped to Python runtime deployment. */
export const hooks: {
  /**
   * Translate local build identities without changing their approval status.
   * @param config - Source workspace configuration.
   * @returns Deployment configuration with exact file URL approvals.
   */
  updateConfig(config: RuntimeDeployConfig): RuntimeDeployConfig
}
