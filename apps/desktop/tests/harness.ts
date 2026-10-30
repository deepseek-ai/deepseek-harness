/** Synthetic Desktop project for built-Host e2e tests; callers own `root` and restore stubbed variables. */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths, type DesktopPaths } from '../src/paths.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'

/** Repository root of this checkout. */
export const repository = fileURLToPath(new URL('../../../', import.meta.url))
/** Built Host entry that these tests require. */
export const builtHost = join(repository, 'apps/desktop-host/lib/index.js')

function version(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
}

/**
 * Stub a credential-free Desktop launch environment and apply a synthetic release under `root`.
 * @param root - Scratch directory owned by the caller.
 * @returns Harness home, synthetic project directory, and Desktop paths under that home.
 */
export async function prepareDesktopHome(root: string): Promise<{ home: string; project: string; paths: DesktopPaths }> {
  for (const name of Object.keys(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/u.test(name)) vi.stubEnv(name, undefined)
  }
  // The production shell supplies the client version that Desktop-only profile rows require.
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  const home = join(root, 'home')
  mkdirSync(home)
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_TELEMETRY_MODE', 'DISABLED')
  const project = prepareDevelopmentProject({
    projectDir: join(root, 'project'),
    cliDir: join(repository, 'apps/cli'),
    hostDir: join(repository, 'apps/desktop-host'),
    dependencyDir: join(repository, 'node_modules/.pnpm/node_modules'),
    release: {
      schemaVersion: 1,
      version: version(join(repository, 'apps/desktop/package.json')),
      pnpmVersion: version(join(repository, 'apps/desktop/node_modules/pnpm/package.json')),
      nodeVersion: process.versions.node,
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    },
    // The synthetic project is not packaged, so nothing compares its descriptor target with this host.
    target: 'mac-x64',
  })
  const paths = resolveDesktopPaths(home)
  await new DesktopProjectManager(paths, { dsh: project }).applyRelease()
  return { home, project, paths }
}
