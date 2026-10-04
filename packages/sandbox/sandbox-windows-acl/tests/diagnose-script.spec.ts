/**
 * The diagnosis script shipped with the `diagnose-windows-sandbox-acl` skill is a
 * runnable artifact, so its classification and its repairs are tested directly
 * rather than through a model.
 *
 * One invocation reads the requested path and every ancestor, then repairs what it
 * can in that same run: a directory on the chain that is `-AllowRoot` itself or
 * strictly inside it and lacks effective WRITE_DAC or WRITE_OWNER receives a
 * FullControl allow ACE for the current user, and every explicit AppContainer
 * package allow ACE is removed at its source, ancestor first. The former `-Fix`,
 * `-GrantFullControl` and `-Compact` switches no longer exist and must be rejected.
 *
 * Every case builds its own scratch directory under the system temp directory and
 * never touches the user profile. The foreign package SID is synthetic: the repair
 * keys on the SID class, not on a profile that exists, so a made-up `S-1-15-2-*`
 * value exercises the same code. ACEs are written with `icacls` and the `*SID`
 * spelling, which no account name has to resolve.
 *
 * Cleanup restores full control on the fixture directories before removing them.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const isWin32 = process.platform === 'win32'

function pwshAvailable(): boolean {
  try {
    execFileSync('where.exe', ['pwsh'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const script = fileURLToPath(new URL('../assets/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1', import.meta.url))
const PACKAGE_SID = 'S-1-15-2-1-2-3-4'
const OTHER_PACKAGE_SID = 'S-1-15-2-4-3-2-1'
const CAPABILITY_SID = 'S-1-15-3-1-2-3-4'
const REMOVED_SWITCHES = ['-Fix', '-GrantFullControl', '-Compact']
// Process creation and Add-Type compilation share the Windows coverage budget.
const timeout = Math.max(90_000, Number(process.env.DSH_COVERAGE_TEST_TIMEOUT_MS ?? 0))

// Vitest's asymmetric factories return any; expected matchers are opaque values.
const containingObject = (value: Record<string, unknown>): unknown => expect.objectContaining(value)
const containingArray = (value: unknown[]): unknown => expect.arrayContaining(value)
const containingString = (value: string): unknown => expect.stringContaining(value)
const anyValue = (constructor: object): unknown => expect.any(constructor)

interface ScriptRun {
  readonly code: number
  readonly output: string
}

interface ScriptReport {
  readonly kind: string
  readonly operation: string
  readonly path: string
  readonly status: string
  readonly reason: string
  readonly details: Record<string, unknown>
}

function reports(run: ScriptRun): ScriptReport[] {
  const result = run.output.split(/\r?\n/u).filter(line => line.startsWith('REPORT '))
    .map(line => JSON.parse(line.slice('REPORT '.length)) as ScriptReport)
  expect(result.length).toBeGreaterThan(0)
  for (const entry of result) expect(entry.reason.length).toBeGreaterThan(0)
  expect(result.at(-1)).toMatchObject({ kind: 'summary', details: { exitCode: run.code } })
  return result
}

function pwsh(command: string): string {
  return execFileSync('pwsh', ['/NoLogo', '/NonInteractive', '/NoProfile', '-Command', command], { encoding: 'utf8', timeout, windowsHide: true })
}

function runPowerShell(args: readonly string[], env?: NodeJS.ProcessEnv): ScriptRun {
  try {
    const stdout = execFileSync('pwsh', ['/NoLogo', '/NonInteractive', '/NoProfile', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: true,
      env,
    })
    return { code: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string }
    if (failure.status === null || failure.status === undefined) throw error
    return { code: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

function runScript(args: readonly string[], env?: NodeJS.ProcessEnv): ScriptRun {
  return runPowerShell(['-File', script, ...args], env)
}

function icacls(path: string, ...args: readonly string[]): string {
  return execFileSync('icacls', [path, ...args], { encoding: 'utf8', timeout, windowsHide: true })
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function sddlOf(path: string): string {
  return pwsh(`(Get-Acl -LiteralPath ${quote(path)}).Sddl`).trim()
}

function ownerOf(path: string): string {
  return pwsh(`(Get-Acl -LiteralPath ${quote(path)}).GetOwner([System.Security.Principal.SecurityIdentifier]).Value`).trim()
}

function aclLines(path: string): string[] {
  return icacls(path).split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
}

function integrityLines(path: string): string[] {
  return aclLines(path).filter(line => /Mandatory|S-1-16-/u.test(line))
}

function normalized(path: string, lines: readonly string[]): string[] {
  return lines.map((line) => {
    const trimmed = line.trim()
    return trimmed.startsWith(path) ? trimmed.slice(path.length).trim() : trimmed
  })
}

describe.skipIf(!isWin32 || !pwshAvailable())('diagnose-windows-sandbox-acl script', { timeout }, () => {
  let meSid!: string

  function newScratch(): string {
    // Windows runners may expose TEMP through an 8.3 alias; PowerShell reports long paths.
    return realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-acl-diagnose-')))
  }

  function makeDir(root: string, name: string): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function stamp(path: string, sid: string, type: 'grant' | 'deny' = 'grant'): void {
    icacls(path, `/${type}`, `*${sid}:(RX)`)
  }

  function dispose(root: string): void {
    // Restore the rights a grant case withheld before deleting the scratch tree.
    pwsh(
      `Get-ChildItem -LiteralPath ${quote(root)} -Recurse -Force -Directory -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { icacls $_.FullName /grant:r "*${meSid}:(F)" | Out-Null }; ` +
      `icacls ${quote(root)} /grant:r "*${meSid}:(F)" | Out-Null`,
    )
    rmSync(root, { recursive: true, force: true })
  }

  beforeAll(() => {
    meSid = pwsh('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value').trim()
    const probe = newScratch()
    try {
      // The script inspects the real ancestor chain, including paths above our owned root.
      const baseline = reports(runScript(['-Path', probe, '-AllowRoot', probe, '-Out', join(probe, 'out')]))
        .find(entry => entry.operation === 'classify')
      if (JSON.stringify(baseline?.details.packageObjects) !== '[]') {
        throw new Error('ACL fixtures require TEMP/TMP on a tree whose ancestors have no individual package allow ACEs; choose a clean test temp root. Host ACLs are never repaired by this suite.')
      }
    } finally {
      dispose(probe)
    }
  }, timeout)

  it('removes a foreign package allow ACE in one run and leaves a paired recovery record', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'stamped')
      const out = join(scratch, 'out')
      stamp(target, PACKAGE_SID)
      const before = normalized(target, aclLines(target))
      expect(before.join('\n')).toContain(PACKAGE_SID)

      const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', out])
      expect(run.code, run.output).toBe(0)
      expect(run.output).toContain('VERDICT=CULPRIT')
      expect(run.output).toContain(`PACKAGE_ACE SID=${PACKAGE_SID}`)
      expect(run.output).toContain(`FIXED ${target} SID=${PACKAGE_SID}`)
      expect(run.output).toContain('SUMMARY FIXED=1 GRANTED=0 REFUSED=0 RESTORED=0')
      expect(run.output).toContain('ROLLBACK pwsh -NoProfile -File')

      const entries = reports(run)
      expect(entries).toEqual(containingArray([
        containingObject({ kind: 'action', operation: 'remove_package_allow', path: target, status: 'started' }),
        containingObject({ kind: 'action', operation: 'remove_package_allow', path: target, status: 'completed' }),
        containingObject({
          kind: 'verification', operation: 'fix', path: target, status: 'verified',
          details: containingObject({ remainingPackageAces: [], otherEntriesUnchanged: true }),
        }),
      ]))
      expect(entries.at(-1)).toMatchObject({ details: containingObject({ nextAction: 'verify_original_confined_operation' }) })

      expect(normalized(target, aclLines(target))).toEqual(before.filter(line => !line.includes(PACKAGE_SID)))

      const files = readdirSync(out)
      // One recovery pair for the change, plus the report file that keeps every record.
      expect(files).toHaveLength(3)
      const recordFile = files.find(file => file.endsWith('.json'))!
      expect(files).toEqual(expect.arrayContaining([recordFile, `${recordFile}.ps1`]))
      expect(recordFile).toMatch(/^acl-backup-[0-9a-f]{32}\.json$/u)
      expect(files.filter(file => /^acl-report-[0-9a-f]{32}\.jsonl$/u.test(file))).toHaveLength(1)
      expect(files.some(file => file.endsWith('.txt'))).toBe(false)
      const record = JSON.parse(readFileSync(join(out, recordFile), 'utf8')) as Record<string, unknown>
      expect(Object.keys(record).sort()).toEqual(['Dacl', 'Observed', 'Path', 'Protected'])
      expect(record.Path).toBe(target)
      expect(record.Protected).toBe(false)
      expect(String(record.Dacl)).toMatch(/^D:/u)
      expect(String(record.Dacl)).toContain(PACKAGE_SID)
      expect(String(record.Observed)).toMatch(/^D:/u)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('treats a healthy directory as not this class and changes nothing', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'healthy')
      const before = normalized(target, aclLines(target))

      const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(0)
      expect(run.output).toContain('VERDICT=NOT_THIS_CLASS')
      expect(run.output).not.toContain('PACKAGE_ACE')
      expect(run.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=0 RESTORED=0')
      expect(reports(run)).toContainEqual(containingObject({ kind: 'decision', operation: 'repair', path: target, status: 'skipped' }))
      expect(normalized(target, aclLines(target))).toEqual(before)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('grants full control to a directory that lacks WRITE_DAC and WRITE_OWNER, preserving owner and label', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'missing-write-owner')
      icacls(target, '/setintegritylevel', 'L')
      const labelsBefore = integrityLines(target)
      expect(labelsBefore.length).toBeGreaterThan(0)
      icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
      const ownerBefore = ownerOf(target)

      const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(0)
      expect(run.output).toContain('VERDICT=PRECONDITION')
      expect(run.output).toContain(`GRANTED ${target} SID=${meSid}`)
      expect(run.output).toContain('SUMMARY FIXED=0 GRANTED=1 REFUSED=0 RESTORED=0')
      expect(aclLines(target).join('\n')).toMatch(/\(F\)/u)
      expect(ownerOf(target)).toBe(ownerBefore)
      expect(integrityLines(target)).toEqual(labelsBefore)

      const entries = reports(run)
      expect(entries).toContainEqual(containingObject({ kind: 'verification', operation: 'grant', path: target, status: 'verified' }))
      expect(entries.at(-1)).toMatchObject({ details: containingObject({ nextAction: 'verify_original_confined_operation' }) })
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('repairs a missing grant and a package ACE in the same invocation', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'both')
      icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
      stamp(target, PACKAGE_SID)
      const ownerBefore = ownerOf(target)

      const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(0)
      expect(run.output).toContain('VERDICT=BOTH')
      expect(run.output).toContain(`GRANTED ${target} SID=${meSid}`)
      expect(run.output).toContain(`FIXED ${target} SID=${PACKAGE_SID}`)
      expect(run.output).toContain('SUMMARY FIXED=1 GRANTED=1 REFUSED=0 RESTORED=0')
      const after = aclLines(target).join('\n')
      expect(after).toMatch(/\(F\)/u)
      expect(after).not.toContain(PACKAGE_SID)
      expect(ownerOf(target)).toBe(ownerBefore)
      expect(reports(run)).toEqual(containingArray([
        containingObject({ kind: 'verification', operation: 'grant', path: target, status: 'verified' }),
        containingObject({ kind: 'verification', operation: 'fix', path: target, status: 'verified' }),
      ]))
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('removes explicit package ACEs ancestor first and verifies the inherited copies', () => {
    const scratch = newScratch()
    try {
      const parent = makeDir(scratch, 'inherited')
      const child = join(parent, 'child')
      const leaf = join(child, 'leaf')
      mkdirSync(leaf, { recursive: true })
      icacls(parent, '/grant', `*${PACKAGE_SID}:(OI)(CI)(RX)`)
      icacls(child, '/grant', `*${OTHER_PACKAGE_SID}:(OI)(CI)(RX)`)
      const paths = [parent, child, leaf]
      const ownersBefore = paths.map(ownerOf)

      const run = runScript(['-Path', leaf, '-AllowRoot', scratch, '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(0)
      expect(run.output).toContain('SUMMARY FIXED=2 GRANTED=0 REFUSED=0 RESTORED=0')

      const entries = reports(run)
      expect(entries.filter(entry => entry.operation === 'remove_package_allow' && entry.status === 'completed').map(entry => entry.path))
        .toEqual([parent, child])
      const verifications = entries.filter(entry => entry.kind === 'verification' && entry.operation === 'fix')
      expect(verifications.map(entry => entry.path)).toEqual([leaf, child, parent])
      for (const entry of verifications) {
        expect(entry).toMatchObject({ status: 'verified', details: containingObject({ remainingPackageAces: [], otherEntriesUnchanged: true }) })
      }

      const expectedPaths = [leaf]
      for (let ancestor = dirname(leaf); ; ancestor = dirname(ancestor)) {
        expectedPaths.push(ancestor)
        if (dirname(ancestor) === ancestor) break
      }
      const inspected = entries.filter(entry => entry.kind === 'observation' && entry.operation === 'inspect_acl')
      expect(inspected.slice(0, expectedPaths.length).map(entry => entry.path)).toEqual(expectedPaths)

      for (const path of paths) expect(aclLines(path).join('\n')).not.toContain('S-1-15-2-')
      expect(paths.map(ownerOf)).toEqual(ownersBefore)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('repairs the whole subtree in one run when only the workspace root is named', () => {
    const scratch = newScratch()
    try {
      // The sandbox reports its provisioning failure on the workspace root while the
      // conflicting entry sits deeper, so one approved call must clear both.
      const root = makeDir(scratch, 'workspace')
      icacls(root, '/inheritance:r', '/grant:r', '*S-1-5-11:(M)')
      const deep = makeDir(root, 'deep')
      const leaf = makeDir(deep, 'leaf')
      icacls(deep, '/inheritance:r', '/grant:r', `*${PACKAGE_SID}:(OI)(CI)(RX)`)
      icacls(leaf, '/inheritance:r', '/grant:r', `*${OTHER_PACKAGE_SID}:(OI)(CI)(RX)`)

      const run = runScript(['-Path', root, '-AllowRoot', root, '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(0)
      // The classification describes what this run repairs: the scanned sources are part
      // of it, not discovered after the verdict was recorded.
      expect(run.output).toContain('VERDICT=BOTH')
      expect(reports(run)).toContainEqual(containingObject({
        kind: 'decision', operation: 'classify', path: root, status: 'BOTH',
        details: containingObject({ packageObjects: containingArray([deep, leaf]) }),
      }))
      expect(run.output).toContain(`GRANTED ${root} SID=${meSid}`)
      expect(run.output).toContain(`FIXED ${deep} SID=${PACKAGE_SID}`)
      expect(run.output).toContain(`FIXED ${leaf} SID=${OTHER_PACKAGE_SID}`)
      expect(run.output).toContain('SUMMARY FIXED=2 GRANTED=1 REFUSED=0 RESTORED=0')
      expect(reports(run)).toContainEqual(containingObject({
        kind: 'observation', operation: 'subtree_scan', path: root,
        details: containingObject({ truncated: false, packageSources: containingArray([deep, leaf]) }),
      }))
      expect(reports(run).at(-1)).toMatchObject({
        details: containingObject({ scanTruncated: false, nextAction: 'verify_original_confined_operation' }),
      })
      expect(aclLines(root).join('\n')).toMatch(/\(F\)/u)
      for (const path of [deep, leaf]) expect(aclLines(path).join('\n')).not.toMatch(/S-1-15-2-/u)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('keeps an inherit-only ACE when it grants the missing right', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'inherit-only')
      icacls(target, '/inheritance:r', '/grant:r', '*S-1-5-11:(M)')
      icacls(target, '/grant', '*S-1-5-32-545:(OI)(CI)(IO)(F)')
      const inheritOnlyBefore = aclLines(target).filter(line => line.includes('(IO)'))
      expect(inheritOnlyBefore).toHaveLength(1)

      const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(0)
      expect(run.output).toContain(`GRANTED ${target} SID=${meSid}`)
      expect(reports(run)).toContainEqual(containingObject({ kind: 'verification', operation: 'grant', path: target, status: 'verified' }))
      expect(aclLines(target).filter(line => line.includes('(IO)'))).toEqual(inheritOnlyBefore)
      expect(aclLines(target).join('\n')).toMatch(/\(F\)/u)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('preserves a deny that shares the removed package allow SID', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'shared-sid')
      // One SID carries both a deny and an allow: only the allow may be removed, and
      // the own-ACE comparison must not treat the surviving deny as a collateral change.
      icacls(target, '/deny', `*${PACKAGE_SID}:(WO)`)
      stamp(target, PACKAGE_SID)

      const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(0)
      expect(run.output).toContain(`FIXED ${target} SID=${PACKAGE_SID}`)
      expect(reports(run)).toContainEqual(containingObject({
        kind: 'verification', operation: 'fix', path: target,
        status: 'verified', details: containingObject({ remainingPackageAces: [], otherEntriesUnchanged: true }),
      }))
      const lines = aclLines(target).filter(line => line.includes(PACKAGE_SID))
      expect(lines.filter(line => line.includes('(DENY)'))).toHaveLength(1)
      expect(lines.filter(line => !line.includes('(DENY)'))).toEqual([])
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('refuses an inherited source outside -AllowRoot before touching an in-root explicit entry', () => {
    const scratch = newScratch()
    try {
      const parent = makeDir(scratch, 'outside-inherited')
      const root = makeDir(parent, 'allowed')
      const child = makeDir(root, 'child')
      icacls(parent, '/grant', `*${PACKAGE_SID}:(OI)(CI)(RX)`)
      stamp(child, OTHER_PACKAGE_SID)
      const before = [parent, child].map(sddlOf)

      const run = runScript(['-Path', child, '-AllowRoot', root, '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(2)
      expect(reports(run)).toContainEqual(containingObject({
        kind: 'decision', status: 'refused', path: parent, reason: containingString('outside -AllowRoot'),
      }))
      expect(reports(run).filter(entry => entry.kind === 'action' && entry.details.effect === 'acl')).toEqual([])
      expect([parent, child].map(sddlOf)).toEqual(before)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('preserves deny ACEs, capability SIDs and the well-known package groups', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'preserved')
      stamp(target, PACKAGE_SID, 'deny')
      stamp(target, CAPABILITY_SID)
      stamp(target, 'S-1-15-2-1')
      stamp(target, 'S-1-15-2-2')
      const before = normalized(target, aclLines(target))

      const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(0)
      expect(run.output).toContain('VERDICT=NOT_THIS_CLASS')
      expect(run.output).not.toContain('PACKAGE_ACE')
      expect(run.output).toContain(`OTHER_S1_15 SID=${CAPABILITY_SID}`)
      expect(reports(run)).toContainEqual(containingObject({
        kind: 'observation', operation: 'inspect_acl', path: target,
        details: containingObject({ aces: containingArray([containingObject({ sid: PACKAGE_SID, type: 'Deny', inherited: false })]) }),
      }))
      expect(normalized(target, aclLines(target))).toEqual(before)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('refuses an object outside -AllowRoot before changing anything and exits 2', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'outside-root')
      const unrelated = makeDir(scratch, 'unrelated-root')
      stamp(target, PACKAGE_SID)
      const before = sddlOf(target)

      const run = runScript(['-Path', target, '-AllowRoot', unrelated, '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(2)
      expect(run.output).toContain('REPAIR_REFUSED')
      expect(run.output).toContain('is outside -AllowRoot')
      expect(run.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=1 RESTORED=0')
      expect(reports(run)).toContainEqual(containingObject({ kind: 'decision', path: target, status: 'refused', reason: containingString('outside -AllowRoot') }))
      expect(sddlOf(target)).toBe(before)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it.each(['allowed', 'link'])('refuses a junction outside -AllowRoot (%s is the root)', (rootKind) => {
    const scratch = newScratch()
    try {
      const allowed = makeDir(scratch, 'allowed')
      const outside = makeDir(scratch, 'outside')
      const target = join(outside, 'target')
      mkdirSync(target)
      stamp(target, PACKAGE_SID)
      const before = sddlOf(target)
      const link = join(allowed, 'link')
      symlinkSync(outside, link, 'junction')
      try {
        const allowRoot = rootKind === 'link' ? link : allowed
        const run = runScript(['-Path', join(link, 'target'), '-AllowRoot', allowRoot, '-Out', join(scratch, 'out')])
        expect(run.code, run.output).toBe(2)
        expect(run.output).toContain('traverses a reparse point')
        expect(reports(run)).toContainEqual(containingObject({ kind: 'decision', status: 'refused', reason: containingString('reparse point') }))
        expect(sddlOf(target)).toBe(before)
      } finally {
        unlinkSync(link)
      }
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it.each(['Packages', 'WindowsApps'])('refuses the managed application tree %s inside -AllowRoot', (directory) => {
    const scratch = newScratch()
    try {
      const root = makeDir(scratch, 'managed-root')
      const child = join(root, directory, 'application')
      mkdirSync(child, { recursive: true })
      stamp(child, PACKAGE_SID)
      const before = sddlOf(child)
      const key = directory === 'Packages' ? 'LOCALAPPDATA' : 'ProgramFiles'
      // PowerShell re-derives ProgramFiles while starting, so assign the override inside the child session.
      const run = runPowerShell(['-Command',
        `$env:${key} = ${quote(root)}; & ${quote(script)} -Path ${quote(child)} -AllowRoot ${quote(root)} -Out ${quote(join(scratch, 'out'))}; exit $LASTEXITCODE`])
      expect(run.code, run.output).toBe(2)
      expect(run.output).toContain('managed application directory')
      expect(run.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=1 RESTORED=0')
      expect(reports(run)).toContainEqual(containingObject({ kind: 'decision', path: child, status: 'refused', reason: containingString('managed application directory') }))
      expect(sddlOf(child)).toBe(before)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('stops and restores the attempted grant when a deny ACE blocks WRITE_OWNER', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'denied-write-owner')
      stamp(target, PACKAGE_SID)
      icacls(target, '/deny', `*${meSid}:(WO)`)
      const before = sddlOf(target)

      const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(2)
      expect(run.output).toContain('GRANT_FAILED')
      expect(run.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=1 RESTORED=1')
      expect(run.output).not.toContain(`FIXED ${target}`)

      const entries = reports(run)
      expect(entries).toEqual(containingArray([
        containingObject({ kind: 'verification', operation: 'grant', path: target, status: 'failed', details: containingObject({ recovery: containingString('-Restore') }) }),
        containingObject({ kind: 'verification', operation: 'restore', path: target, status: 'verified' }),
      ]))
      expect(entries.at(-1)).toMatchObject({
        details: containingObject({ rollback: 'verified', nextAction: 'stop', granted: 0, refused: 1, restored: 1, rollbackCommands: [] }),
      })
      expect(sddlOf(target)).toBe(before)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('restores every attempted change in reverse order when a later path fails', () => {
    const scratch = newScratch()
    try {
      const out = join(scratch, 'out')
      const first = makeDir(scratch, 'multi-first')
      icacls(first, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
      const second = makeDir(scratch, 'multi-second')
      stamp(second, PACKAGE_SID)
      icacls(second, '/deny', `*${meSid}:(WO)`)
      const before = [sddlOf(first), sddlOf(second)]

      const run = runPowerShell(['-Command', `& ${quote(script)} -Path @(${quote(first)}, ${quote(second)}) -AllowRoot ${quote(scratch)} -Out ${quote(out)}; exit $LASTEXITCODE`])
      expect(run.code, run.output).toBe(2)
      expect(reports(run).filter(entry => entry.kind === 'verification' && entry.operation === 'restore').map(entry => entry.path))
        .toEqual([second, first])
      expect(reports(run).at(-1)).toMatchObject({ details: containingObject({ rollback: 'verified', nextAction: 'stop' }) })
      expect([sddlOf(first), sddlOf(second)]).toEqual(before)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('prints the pending recovery command and reports restore_pending_then_stop when rollback fails', () => {
    const scratch = newScratch()
    try {
      const out = join(scratch, 'out')
      const first = makeDir(scratch, 'pending-first')
      icacls(first, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
      const second = makeDir(scratch, 'pending-second')
      stamp(second, PACKAGE_SID)
      icacls(second, '/deny', `*${meSid}:(WO)`)
      const wrapper = join(scratch, 'fail-rollback.ps1')
      writeFileSync(wrapper, `
$global:firstReads = 0
function Get-Acl {
  param([string]$LiteralPath)
  if ($LiteralPath -ieq ${quote(first)}) {
    $global:firstReads++
    if ($global:firstReads -ge 4) { throw [System.IO.IOException]::new('rollback read unavailable') }
  }
  Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $LiteralPath
}
& ${quote(script)} -Path @(${quote(first)}, ${quote(second)}) -AllowRoot ${quote(scratch)} -Out ${quote(out)}
exit $LASTEXITCODE
`)

      const run = runPowerShell(['-File', wrapper])
      expect(run.code, run.output).toBe(2)
      const entries = reports(run)
      expect(entries.at(-1)).toMatchObject({ details: containingObject({ rollback: 'failed', nextAction: 'restore_pending_then_stop' }) })
      const commands = entries.at(-1)!.details.rollbackCommands as string[]
      expect(commands).toHaveLength(1)
      expect(commands[0]).toContain('-Restore')

      const recovery = runPowerShell(['-Command', `${commands[0]!}; exit $LASTEXITCODE`])
      expect(recovery.code, recovery.output).toBe(0)
      expect(reports(recovery)).toContainEqual(containingObject({ kind: 'verification', operation: 'restore', status: 'verified' }))
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('restores the saved DACL from the recovery record and the printed command', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'restore-target')
      stamp(target, PACKAGE_SID)
      const before = sddlOf(target)
      const out = join(scratch, 'out')
      const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', out])
      expect(repair.code, repair.output).toBe(0)
      expect(sddlOf(target)).not.toBe(before)
      const record = join(out, readdirSync(out).find(file => file.endsWith('.json'))!)

      const rollbackLine = repair.output.split(/\r?\n/u).find(line => line.startsWith('ROLLBACK '))
      expect(rollbackLine, repair.output).toBeDefined()
      const viaCommand = runPowerShell(['-Command', `${rollbackLine!.slice('ROLLBACK '.length)}; exit $LASTEXITCODE`])
      expect(viaCommand.code, viaCommand.output).toBe(0)
      expect(reports(viaCommand)).toContainEqual(containingObject({ kind: 'verification', operation: 'restore', status: 'verified' }))
      expect(sddlOf(target)).toBe(before)

      const viaRecord = runScript(['-Path', target, '-AllowRoot', scratch, '-Restore', record])
      expect(viaRecord.code, viaRecord.output).toBe(0)
      expect(viaRecord.output).toContain(`RESTORED ${target}`)
      expect(viaRecord.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=0 RESTORED=1')
      expect(reports(viaRecord).at(-1)).toMatchObject({ details: containingObject({ nextAction: 'stop' }) })
      expect(sddlOf(target)).toBe(before)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('rejects a missing -AllowRoot, a repair without -Out, and -Restore with two paths', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'validation')
      const other = makeDir(scratch, 'validation-other')
      stamp(target, PACKAGE_SID)

      const noRoot = runScript(['-Path', target, '-Out', join(scratch, 'out')])
      expect(noRoot.code).toBe(2)
      expect(reports(noRoot)).toContainEqual(containingObject({
        kind: 'error', status: 'stopped', details: containingObject({ error: containingString('Every modification requires -AllowRoot') }),
      }))

      const noOut = runScript(['-Path', target, '-AllowRoot', scratch])
      expect(noOut.code).toBe(2)
      expect(reports(noOut)).toContainEqual(containingObject({
        kind: 'error', status: 'stopped', details: containingObject({ error: containingString('requires -Out') }),
      }))

      const twoPaths = runPowerShell(['-Command', `& ${quote(script)} -Path @(${quote(target)}, ${quote(other)}) -AllowRoot ${quote(scratch)} -Restore 'anything.json'; exit $LASTEXITCODE`])
      expect(twoPaths.code).toBe(2)
      expect(reports(twoPaths)).toContainEqual(containingObject({
        kind: 'error', status: 'stopped', details: containingObject({ error: containingString('exactly one -Path') }),
      }))
      expect(aclLines(target).join('\n')).toContain(PACKAGE_SID)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it.each(REMOVED_SWITCHES)('rejects the removed %s switch', (flag) => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'removed-switch')
      const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', join(scratch, 'out'), flag])
      expect(run.code, run.output).not.toBe(0)
      expect(run.output).not.toContain('REPORT ')
    } finally {
      dispose(scratch)
    }
  })

  it('reports a missing requested path without changing anything', () => {
    const scratch = newScratch()
    try {
      const missing = join(scratch, 'missing')
      const run = runScript(['-Path', missing, '-AllowRoot', scratch, '-Out', join(scratch, 'out')])
      expect(run.code).toBe(2)
      expect(run.output).toContain('MISSING')
      expect(run.output).toContain('VERDICT=NOT_THIS_CLASS')
      expect(run.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=1 RESTORED=0')
      expect(reports(run)).toContainEqual(containingObject({ kind: 'decision', path: missing, status: 'skipped', reason: containingString('does not exist') }))
    } finally {
      dispose(scratch)
    }
  })

  it('reports an unusable output directory without attempting an ACL write', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'backup-failure')
      icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
      const outputFile = join(scratch, 'not-a-directory')
      writeFileSync(outputFile, 'Existing contents')
      const before = sddlOf(target)

      const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outputFile])
      expect(run.code).toBe(1)
      const entries = reports(run)
      expect(entries).toContainEqual(containingObject({ kind: 'action', operation: 'prepare_report', status: 'failed', details: containingObject({ error: anyValue(String) }) }))
      expect(entries.filter(entry => entry.kind === 'action' && entry.details.effect === 'acl')).toEqual([])
      expect(sddlOf(target)).toBe(before)
      expect(readFileSync(outputFile, 'utf8')).toBe('Existing contents')
    } finally {
      dispose(scratch)
    }
  })

  it('reports an unreadable ACL as a partial observation without inventing permissions', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'unreadable-observation')
      const before = sddlOf(target)
      const run = runPowerShell(['-Command', `
function Get-Acl { param([string]$LiteralPath); throw [System.IO.IOException]::new('ACL observation unavailable') }
& ${quote(script)} -Path ${quote(target)} -AllowRoot ${quote(scratch)} -Out ${quote(join(scratch, 'out'))}; exit $LASTEXITCODE
`])
      expect(run.code).toBe(0)
      expect(run.output).toContain('VERDICT=UNREADABLE')
      const entries = reports(run)
      expect(entries).toContainEqual(containingObject({
        kind: 'observation', path: target, status: 'unreadable',
        details: containingObject({ error: containingString('ACL observation unavailable') }),
      }))
      expect(entries.at(-1)).toMatchObject({ kind: 'summary', status: 'partial', details: containingObject({ observationFailures: anyValue(Number) }) })
      expect(entries.filter(entry => entry.kind === 'action' && entry.details.effect === 'acl')).toEqual([])
      expect(sddlOf(target)).toBe(before)
    } finally {
      dispose(scratch)
    }
  })

  it('treats missing observations as incomplete and refuses before changing anything', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'incomplete-observation')
      const before = sddlOf(target)
      const run = runPowerShell(['-Command', `
function icacls { throw [System.IO.IOException]::new('icacls unavailable') }
& ${quote(script)} -Path ${quote(target)} -AllowRoot ${quote(scratch)} -Out ${quote(join(scratch, 'out'))}; exit $LASTEXITCODE
`])
      expect(run.code, run.output).toBe(2)
      expect(run.output).toContain('VERDICT=INCOMPLETE')
      expect(run.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=1 RESTORED=0')
      expect(reports(run)).toContainEqual(containingObject({ kind: 'decision', path: target, status: 'refused', reason: containingString('observations are incomplete') }))
      expect(sddlOf(target)).toBe(before)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('refuses to restore a record for another path or a path outside -AllowRoot', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'restore-guard-target')
      const other = makeDir(scratch, 'restore-guard-other')
      stamp(target, PACKAGE_SID)
      const out = join(scratch, 'out')
      const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', out])
      expect(repair.code, repair.output).toBe(0)
      const record = join(out, readdirSync(out).find(file => file.endsWith('.json'))!)

      const otherBefore = sddlOf(other)
      const mismatch = runScript(['-Path', other, '-AllowRoot', scratch, '-Restore', record])
      expect(mismatch.code).toBe(2)
      expect(mismatch.output).toContain('does not describe the requested path')
      expect(sddlOf(other)).toBe(otherBefore)

      const targetBefore = sddlOf(target)
      const outside = runScript(['-Path', target, '-AllowRoot', other, '-Restore', record])
      expect(outside.code).toBe(2)
      expect(outside.output).toContain('outside -AllowRoot')
      expect(sddlOf(target)).toBe(targetBefore)
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('repairs its own workspace root when -AllowRoot is the object itself', () => {
    const scratch = newScratch()
    try {
      const out = join(scratch, 'out')
      const grantRoot = makeDir(scratch, 'self-grant')
      icacls(grantRoot, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
      const grantRun = runScript(['-Path', grantRoot, '-AllowRoot', grantRoot, '-Out', out])
      expect(grantRun.code, grantRun.output).toBe(0)
      expect(grantRun.output).toContain(`GRANTED ${grantRoot} SID=${meSid}`)
      expect(grantRun.output).not.toContain('outside -AllowRoot')

      const fixRoot = makeDir(scratch, 'self-fix')
      stamp(fixRoot, PACKAGE_SID)
      const fixRun = runScript(['-Path', fixRoot, '-AllowRoot', fixRoot, '-Out', out])
      expect(fixRun.code, fixRun.output).toBe(0)
      expect(fixRun.output).toContain(`FIXED ${fixRoot} SID=${PACKAGE_SID}`)
      expect(fixRun.output).not.toContain('outside -AllowRoot')
    } finally {
      dispose(scratch)
    }
  }, timeout)

  it('is idempotent: a second repair run changes nothing', () => {
    const scratch = newScratch()
    try {
      const target = makeDir(scratch, 'idempotent')
      icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
      stamp(target, PACKAGE_SID)
      const out = join(scratch, 'out')

      const first = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', out])
      expect(first.code, first.output).toBe(0)
      expect(first.output).toContain('SUMMARY FIXED=1 GRANTED=1 REFUSED=0 RESTORED=0')
      const afterFirst = normalized(target, aclLines(target))

      const second = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', out])
      expect(second.code, second.output).toBe(0)
      expect(second.output).toContain('VERDICT=NOT_THIS_CLASS')
      expect(second.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=0 RESTORED=0')
      expect(normalized(target, aclLines(target))).toEqual(afterFirst)
    } finally {
      dispose(scratch)
    }
  }, timeout)
})
