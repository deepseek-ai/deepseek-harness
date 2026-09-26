/**
 * A profile installs this package from npm beside the dsh installation, so the
 * host runtimes it mounts must resolve to the installation's single module
 * instance. `dsh-scope` mints its scope-tag symbol and `dsh-mcp-client` keeps
 * its live `serverName` reservations per module instance.
 *
 * A dependency edge installs a second copy instead. That copy's `createScope`
 * writes a tag every host registry ignores, so each Agent's MCP tools land in
 * the global tool layer: the first Agent registers them, and every later
 * Agent's tool synchronization fails and rejects creation.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))

/** Host runtimes whose module-local state must not be duplicated. */
const SHARED_HOST_RUNTIMES = ['@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-scope'] as const

describe('profile installs share the installation host runtime instances', () => {
  it('declares every identity-bearing host runtime as a peer, never a dependency', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
    for (const name of SHARED_HOST_RUNTIMES) {
      expect(manifest.peerDependencies?.[name], `${name} must be a peerDependency`).toBe('workspace:*')
      expect(manifest.devDependencies?.[name], `${name} must also be a devDependency`).toBe('workspace:*')
      expect(manifest.dependencies?.[name], `${name} must not be a dependency`).toBeUndefined()
    }
  })
})
