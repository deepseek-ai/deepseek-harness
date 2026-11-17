/**
 * Workspace picker plugin, node half. The browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration. The Host behavior is this plugin's configuration: its volatile
 * fields are the live values the browser receives through its synced Config.
 */
import z from '@deepseek-ai/schemastery'
import type { WorkspaceNavigationConfig } from './types.ts'

/** Live Workspace navigation preferences; the browser receives them through its synced Config. */
export type Config = WorkspaceNavigationConfig

/** Live Workspace navigation preferences projected to the browser. */
export const Config = z.object({
  recentViewLimit: z.natural().default(10).volatile(),
})

/** Register the browser plugin without Host behavior. */
export function apply(): void {}
