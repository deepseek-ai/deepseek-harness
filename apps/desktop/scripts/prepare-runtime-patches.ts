/** Stage explicitly selected Desktop patches without modifying the source workspace. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import yaml from 'js-yaml'
import { valid } from 'semver'
import { DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES, DESKTOP_RUNTIME_PATCHES, type DesktopRuntimePatch } from './runtime-patch-policy.ts'

/** Expected patch bytes and package version for one independent installation. */
export interface PreparedRuntimePatch {
  spec: string
  name: string
  version: string
  path: string
  hash: string
}

/** Selected bytes and dependencies excluded from the Desktop runtime. */
export interface PreparedRuntimePatches {
  patches: PreparedRuntimePatch[]
  workspaceOnly: string[]
}

function patchIdentity(spec: string): { name: string; version: string } {
  const separator = spec.lastIndexOf('@')
  const name = spec.slice(0, separator)
  const version = spec.slice(separator + 1)
  if (separator <= 0 || valid(version) !== version) throw new Error(`desktop patches: expected an exact package version: ${spec}`)
  return { name, version }
}

function patchHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Stage selected patches and explicit overrides before Desktop resolves its temporary lockfile.
 * Every root patch must be classified; shared bytes must match the root lockfile's pnpm 11 hash.
 * @param projectRoot Disposable project containing pnpm-workspace.yaml, outside the repository root itself.
 * @param repositoryRoot Source repository; its files remain read-only.
 * @param policy Desktop patch decisions, including optional runtime-only files relative to the repository.
 * @param overrides Explicit Desktop dependency constraints; patch versions never generate overrides.
 * @returns Expected patch identities and hashes for lockfile and staged-file verification.
 */
export function prepareRuntimePatches(
  projectRoot: string, repositoryRoot: string,
  policy: Readonly<Record<string, DesktopRuntimePatch>> = DESKTOP_RUNTIME_PATCHES,
  overrides: Readonly<Record<string, string>> = DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES,
): PreparedRuntimePatches {
  if (resolve(projectRoot) === resolve(repositoryRoot)) throw new Error('desktop patches: destination must not be the source workspace')
  const source = yaml.load(readFileSync(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')) as {
    patchedDependencies: Record<string, string>
  }
  const sourceLock = yaml.load(readFileSync(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')) as {
    patchedDependencies: Record<string, string>
  }
  for (const spec of Object.keys(source.patchedDependencies)) {
    if (!Object.hasOwn(policy, spec)) throw new Error(`desktop patches: classify the workspace patch ${spec}`)
  }
  const selected: Array<PreparedRuntimePatch & { bytes: Buffer }> = []
  for (const [spec, rule] of Object.entries(policy)) {
    const identity = patchIdentity(spec)
    if (rule.scope !== 'runtime-only' && !Object.hasOwn(source.patchedDependencies, spec)) {
      throw new Error(`desktop patches: stale workspace patch decision ${spec}`)
    }
    if (rule.scope === 'workspace-only') continue
    const sourcePath = rule.scope === 'shared' ? source.patchedDependencies[spec]! : rule.path
    const localPath = relative(resolve(repositoryRoot), resolve(repositoryRoot, sourcePath))
    if (isAbsolute(sourcePath) || localPath.startsWith('..') || isAbsolute(localPath)) {
      throw new Error(`desktop patches: patch must be inside the repository: ${sourcePath}`)
    }
    const bytes = readFileSync(join(repositoryRoot, sourcePath))
    const hash = patchHash(bytes)
    if (rule.scope === 'shared' && sourceLock.patchedDependencies[spec] !== hash) {
      throw new Error(`desktop patches: shared patch hash differs from the root lockfile: ${spec}`)
    }
    selected.push({ spec, ...identity, path: `patches/desktop-${selected.length}.patch`, hash, bytes })
  }
  const targetPath = join(projectRoot, 'pnpm-workspace.yaml')
  const target = yaml.load(readFileSync(targetPath, 'utf8')) as Record<string, unknown> & { overrides?: Record<string, string> }
  for (const [name, version] of Object.entries(overrides)) {
    if (target.overrides?.[name] !== undefined && target.overrides[name] !== version) {
      throw new Error(`desktop patches: conflicting dependency override for ${name}`)
    }
  }
  mkdirSync(join(projectRoot, 'patches'), { recursive: true })
  for (const entry of selected) writeFileSync(join(projectRoot, entry.path), entry.bytes)
  writeFileSync(targetPath, yaml.dump({ ...target, overrides: { ...target.overrides, ...overrides },
    patchedDependencies: Object.fromEntries(selected.map(entry => [entry.spec, entry.path])), allowUnusedPatches: false }))
  return { patches: selected.map(({ bytes: _bytes, ...entry }) => entry),
    workspaceOnly: Object.entries(policy).filter(([, rule]) => rule.scope === 'workspace-only').map(([spec]) => patchIdentity(spec).name) }
}

/**
 * Reject changed patch bytes, lock hashes or resolved versions before the frozen production install.
 * @param projectRoot Independent Desktop installation containing its resolved lockfile.
 * @param plan Expected identities and exclusions returned by patch preparation.
 */
export function verifyRuntimePatches(projectRoot: string, plan: PreparedRuntimePatches): void {
  const lock = yaml.load(readFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'utf8')) as {
    patchedDependencies?: Record<string, string>
    packages?: Record<string, { version?: string }>
  }
  for (const patch of plan.patches) {
    if (!Object.keys(lock.packages ?? {}).some(spec => spec.startsWith(`${patch.name}@`))) {
      throw new Error(`desktop patches: selected patch has no runtime dependency: ${patch.spec}`)
    }
    if (patchHash(readFileSync(join(projectRoot, patch.path))) !== patch.hash) {
      throw new Error(`desktop patches: staged patch bytes changed: ${patch.spec}`)
    }
    if (lock.patchedDependencies?.[patch.spec] !== patch.hash) {
      throw new Error(`desktop patches: lockfile patch hash mismatch: ${patch.spec}`)
    }
  }
  for (const [spec, entry] of Object.entries(lock.packages ?? {})) {
    if (plan.workspaceOnly.some(name => spec.startsWith(`${name}@`))) {
      throw new Error(`desktop patches: workspace-only dependency entered the runtime: ${spec}; review its patch scope`)
    }
    const candidates = plan.patches.filter(patch => spec.startsWith(`${patch.name}@`))
    if (candidates.length === 0) continue
    if (!candidates.some(patch => (entry.version ?? spec.slice(patch.name.length + 1)) === patch.version)) {
      throw new Error(`desktop patches: ${spec} has no matching patch; review its version and Desktop patch policy`)
    }
  }
}
