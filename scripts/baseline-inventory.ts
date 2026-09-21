/**
 * Recorded-inventory bookkeeping for gates that reject one source form.
 *
 * A gate scans first-party source, records the findings that predate its rule as a fingerprint
 * inventory, and rejects a finding the inventory does not allow. Keying by repository path and by
 * the finding's syntax tokens keeps an allowance across formatting and comment edits, while a
 * changed form needs a new allowance. Fixing a recorded finding leaves a stale allowance, which
 * `--prune` retires.
 *
 * The inventory grows in exactly one case: a merge that brings findings recorded on the target
 * branch. `--record REF` writes the current findings only after proving each one the inventory did
 * not already allow is also a finding at `REF`, so no command can allow a finding this branch
 * introduced.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'

/** Source areas every inventory gate must find, so a narrowed scan cannot pass silently. */
const AREAS = ['packages/', 'apps/', 'scripts/', 'website/'] as const

/** Source extensions an inventory gate scans, including tests and configuration files. */
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/u

/** Existing finding counts, keyed by repository path and syntax fingerprint. */
export type InventoryBaseline = Record<string, Record<string, number>>

/** One finding a gate rejects unless the inventory records it. */
export interface InventoryFinding {
  /** Repository-relative path with forward slashes. */
  file: string
  /** SHA-256 of the finding's syntax tokens, excluding comments and whitespace. */
  fingerprint: string
}

/** Everything shared inventory bookkeeping needs to know about one gate. */
export interface InventoryGate<T extends InventoryFinding> {
  /** Gate name that prefixes every diagnostic and names the `pnpm run` script. */
  name: string
  /** Repository-relative path of the recorded inventory. */
  baselinePath: string
  /** Scan first-party source for the rejected form. */
  scan: (repoRoot: string) => T[]
  /** Rejection text after the gate name for a finding the inventory does not allow. */
  rejection: string
  /** One line describing a finding, appended to {@link rejection}. */
  describe: (finding: T) => string
  /** Console line for a passing run, given the number of recorded findings. */
  success: (count: number) => string
}

/**
 * Whether a repository path belongs to an inventory gate's corpus.
 * @param file - repository-relative path with forward slashes.
 * @returns `true` for first-party source outside vendored code and frozen archived notes.
 */
export function isInventorySource(file: string): boolean {
  return SOURCE_EXTENSIONS.test(file)
    && !file.startsWith('vendor/')
    && !file.startsWith('.agents/notes/archived/')
}

/**
 * Hash a node's syntax tokens, so formatting and comment edits keep one identity.
 * @param node - the node whose form the inventory records.
 * @param source - the file that owns the node.
 * @returns SHA-256 of the node's token texts.
 */
export function syntaxFingerprint(node: ts.Node, source: ts.SourceFile): string {
  const tokens: string[] = []
  const visit = (child: ts.Node): void => {
    if (ts.isJSDoc(child)) return
    if (ts.isToken(child)) tokens.push(child.getText(source))
    else child.getChildren(source).forEach(visit)
  }
  visit(node)
  return createHash('sha256').update(JSON.stringify(tokens)).digest('hex')
}

/**
 * List the first-party source paths a gate scans.
 * @param repoRoot - repository root containing the Git index.
 * @param name - gate name for diagnostics.
 * @returns sorted repository-relative paths of tracked and non-ignored untracked source files.
 * @throws when a required source area is missing or an eligible path is a symlink.
 */
export function listInventorySources(repoRoot: string, name: string): string[] {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).split('\0').map(file => file.replaceAll('\\', '/')).filter(isInventorySource))].sort()
  const present = files.filter((file) => {
    const stat = lstatSync(resolve(repoRoot, file), { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw new Error(`${name}: source symlink is unsupported: ${file}`)
    return stat?.isFile() === true
  })
  for (const area of AREAS) {
    if (!present.some(file => file.startsWith(area))) {
      throw new Error(`${name}: source discovery omitted ${area}`)
    }
  }
  return present
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read and validate one recorded inventory.
 * @param gate - the gate whose findings the inventory allows.
 * @param repoRoot - repository root holding the inventory.
 * @returns the recorded counts, keyed by repository path and fingerprint.
 * @throws when the inventory is malformed or names a path outside the gate's corpus.
 */
export function readInventoryBaseline<T extends InventoryFinding>(
  gate: InventoryGate<T>,
  repoRoot: string,
): InventoryBaseline {
  const value: unknown = JSON.parse(readFileSync(resolve(repoRoot, gate.baselinePath), 'utf8'))
  if (!isRecord(value)) throw new Error(`${gate.name}: baseline must be a file-to-counts object`)
  const baseline: InventoryBaseline = {}
  for (const [file, counts] of Object.entries(value)) {
    if (!isInventorySource(file) || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')
      || !isRecord(counts) || Object.keys(counts).length === 0) {
      throw new Error(`${gate.name}: invalid baseline file: ${file}`)
    }
    const parsed: Record<string, number> = {}
    for (const [fingerprint, count] of Object.entries(counts)) {
      if (!/^[a-f0-9]{64}$/u.test(fingerprint) || typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`${gate.name}: invalid baseline count: ${file}:${fingerprint}`)
      }
      parsed[fingerprint] = count
    }
    baseline[file] = parsed
  }
  return baseline
}

/**
 * Count exact findings without granting a file-wide allowance.
 * @param findings - observed findings.
 * @returns path and fingerprint counts in stable order for comparison and pruning.
 */
export function countInventory(findings: readonly InventoryFinding[]): InventoryBaseline {
  const baseline: InventoryBaseline = {}
  for (const { file, fingerprint } of findings) {
    const counts = baseline[file] ??= {}
    counts[fingerprint] = (counts[fingerprint] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b))
    .map(([file, counts]) => [file, Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))]))
}

/**
 * Enforce one gate's recorded inventory, optionally deleting retired allowances.
 * @param gate - the gate to enforce.
 * @param repoRoot - repository root to scan.
 * @param prune - remove stale entries only after establishing that no new finding exists.
 * @returns the number of findings still present.
 * @throws for new findings, malformed inventories, or stale entries without pruning.
 */
export function verifyInventory<T extends InventoryFinding>(
  gate: InventoryGate<T>,
  repoRoot: string,
  prune = false,
): number {
  const baseline = readInventoryBaseline(gate, repoRoot)
  const findings = gate.scan(repoRoot)
  const remaining = structuredClone(baseline)
  const added: T[] = []
  for (const finding of findings) {
    const counts = remaining[finding.file]
    const allowance = counts?.[finding.fingerprint] ?? 0
    if (counts !== undefined && allowance > 0) counts[finding.fingerprint] = allowance - 1
    else added.push(finding)
  }
  if (added.length > 0) {
    throw new Error(`${gate.name}: ${gate.rejection}\n`
      + added.map(finding => `  ${gate.describe(finding)}`).join('\n'))
  }
  const stale = Object.entries(remaining).flatMap(([file, counts]) => Object.entries(counts)
    .filter(([, count]) => count > 0).map(([fingerprint]) => `  ${file} (${fingerprint})`))
  if (stale.length > 0) {
    if (!prune) {
      throw new Error(`${gate.name}: remove retired baseline entries with pnpm run ${gate.name} --prune.\n`
        + stale.join('\n'))
    }
    writeFileSync(resolve(repoRoot, gate.baselinePath), `${JSON.stringify(countInventory(findings), null, 2)}\n`)
  }
  return findings.length
}

/** Scan one gate's corpus at another revision, checked out through a temporary Git worktree. */
function scanRevision<T extends InventoryFinding>(gate: InventoryGate<T>, repoRoot: string, ref: string): T[] {
  const path = mkdtempSync(join(tmpdir(), 'dsh-inventory-'))
  try {
    execFileSync('git', ['worktree', 'add', '--detach', path, ref], { cwd: repoRoot, stdio: 'pipe' })
    return gate.scan(path)
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', path], { cwd: repoRoot, stdio: 'pipe' })
    } catch (_worktreeNeverAdded) {
      // A checkout that failed to materialize leaves nothing to remove.
    }
    rmSync(path, { recursive: true, force: true })
  }
}

/** Identity of one finding inside a revision, for set membership across revisions. */
function findingKey(finding: InventoryFinding): string {
  return `${finding.file}\0${finding.fingerprint}`
}

/**
 * Record the current findings, after proving every finding the inventory does not allow also
 * exists at `ref`. Entries whose findings are gone are dropped in the same write.
 * @param gate - the gate whose inventory to write.
 * @param repoRoot - repository root to scan and write.
 * @param ref - a revision the repository contains, normally the merged target branch.
 * @returns the number of recorded findings.
 * @throws when `ref` is not an ancestor of the current commit, or a newly allowed finding is absent at `ref`.
 */
export function recordInventory<T extends InventoryFinding>(
  gate: InventoryGate<T>,
  repoRoot: string,
  ref: string,
): number {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: repoRoot, stdio: 'pipe' })
  } catch (_notAnAncestor) {
    throw new Error(`${gate.name}: --record needs a revision the current branch already contains: ${ref}`)
  }
  const baseline = readInventoryBaseline(gate, repoRoot)
  const findings = gate.scan(repoRoot)
  const recorded = new Set(scanRevision(gate, repoRoot, ref).map(findingKey))
  const unproven = findings.filter(finding =>
    (baseline[finding.file]?.[finding.fingerprint] ?? 0) === 0 && !recorded.has(findingKey(finding)))
  if (unproven.length > 0) {
    throw new Error(`${gate.name}: --record refuses findings absent at ${ref}:\n`
      + unproven.map(finding => `  ${gate.describe(finding)}`).join('\n'))
  }
  writeFileSync(resolve(repoRoot, gate.baselinePath), `${JSON.stringify(countInventory(findings), null, 2)}\n`)
  return findings.length
}

/**
 * Run one gate as a command: `--prune` retires stale entries, `--record REF` writes the inventory
 * for a merged tree, no argument verifies, anything else fails the process.
 * @param gate - the gate to enforce.
 * @param root - repository root to scan.
 */
export function runInventoryGate<T extends InventoryFinding>(gate: InventoryGate<T>, root: string): void {
  try {
    const [first, second] = process.argv.slice(2)
    if (process.argv.length === 3 && first === '--prune') {
      console.log(gate.success(verifyInventory(gate, root, true)))
    } else if (process.argv.length === 4 && first === '--record' && second !== undefined) {
      console.log(`${gate.name}: recorded ${String(recordInventory(gate, root, second))} findings.`)
    } else if (process.argv.length === 2) {
      console.log(gate.success(verifyInventory(gate, root)))
    } else {
      throw new Error(`Usage: pnpm run ${gate.name} [--prune | --record <ref>]`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
