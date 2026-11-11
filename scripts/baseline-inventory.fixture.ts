/** Temporary-repository fixture shared by recorded-inventory gate specs. */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Repository roots created by {@link createInventoryRepo}, removed by {@link removeInventoryRepos}. */
const roots: string[] = []

/**
 * Write one fixture file, creating its parent directories.
 * @param root - fixture repository root.
 * @param file - repository-relative path.
 * @param contents - file text.
 */
export function writeFixture(root: string, file: string, contents: string): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

/**
 * Run one Git command in a fixture repository.
 * @param root - fixture repository root.
 * @param args - Git arguments.
 */
export function gitFixture(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' })
}

/**
 * Create a temporary repository with one seed source file per scanned area and an empty inventory.
 * @param baselinePath - repository-relative inventory path the gate reads.
 * @param seed - contents of each area's seed source file.
 * @returns the repository root, tracked for {@link removeInventoryRepos}.
 */
export function createInventoryRepo(baselinePath: string, seed: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inventory-'))
  roots.push(root)
  gitFixture(root, 'init', '--quiet')
  for (const area of ['packages', 'apps', 'scripts', 'website']) {
    writeFixture(root, `${area}/seed.ts`, seed)
  }
  writeFixture(root, baselinePath, '{}\n')
  gitFixture(root, 'add', '.')
  return root
}

/** Remove every repository created by {@link createInventoryRepo}. */
export function removeInventoryRepos(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}
