/** Windows packaging parameter summary without machine configuration access. */
/**
 * Summarize allowlisted workflow inputs and resolved build identity.
 * @param environment Workflow inputs and GitHub run identity.
 * @returns Markdown tables without a build or signature success claim.
 */
export function windowsPackagingSummary(environment: NodeJS.ProcessEnv): string
