/**
 * Check the selected machine configuration without authorizing publication or reading secrets.
 * @param env Selected package or approved route and machine directories.
 * @returns Resolves when the selected configuration is a readable JSON object; full validation remains in the publisher.
 */
export function preflightDesktopPublishLocal(env: NodeJS.ProcessEnv): Promise<void>
