/**
 * Start a test-owned service launcher for one private helper copy.
 * @param helperPath - Executable copied into the test workspace.
 * @returns Cleanup that awaits every owned service exit.
 */
export function startFixtureHost(helperPath: string): Promise<() => Promise<void>>
