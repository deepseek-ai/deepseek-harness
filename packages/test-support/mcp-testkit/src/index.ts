/**
 * MCP test fixtures shared by the MCP client, the MCP manager, and connector plugins: a loopback OAuth world and a
 * real profile that mounts the MCP client host and the manager.
 *
 * @module @deepseek-ai/dsh-mcp-testkit
 */

export { authorize, callback, captureLogs, oauthWorld, phase } from './oauth-world.ts'
export type { OAuthBehavior, OAuthRequest, OAuthWorld } from './oauth-world.ts'
export { managerProfile } from './manager-profile.ts'
export type { ManagerProfile } from './manager-profile.ts'
