import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { packedWorkspaceClosure, readWorkspacePackages } from './packed-workspace-closure.ts'

/**
 * Keyless publish-path rehearsal. It packs the provider, its workspace peers, the vendored framework
 * peer, and the current repository's Landlock entry/platform packages, then installs those exact
 * tarballs in an external plain-Node consumer. The host launcher comes from the exact local tarballs,
 * so no registry copy, tsx, path mapping, or workspace resolution can hide missing files, dependency
 * errors, or lost executable modes. npm may still query registry metadata for an incompatible optional platform
 * package that cannot supply the host launcher.
 *
 * The installed launcher must match the host architecture, remain executable, and either confine a
 * real process with bwrap disabled or fail closed on a non-enforcing kernel. Skips off Linux or
 * before the harness and native packages are built.
 */

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const nativeDir = join(repoRoot, 'native/system')
const sourceLauncher = join(nativeDir, 'packages', `linux-${process.arch}`, 'bin', 'landlock-run')
const platformPackageName = `@deepseek-ai/node-addon-system-linux-${process.arch}`

const NATIVE_PACKAGE_PREFIX = '@deepseek-ai/node-addon-system'

/** ELF `e_machine` (offset 18, LE) for this host: x86-64 = 62, AArch64 = 183. */
const E_MACHINE = { x64: 62, arm64: 183 }[process.arch as 'x64' | 'arm64']

const packable = process.platform === 'linux'
  && E_MACHINE !== undefined
  && existsSync(join(packageDir, 'lib', 'index.js'))
  && existsSync(join(nativeDir, 'packages/entry/lib/index.js'))
  && existsSync(sourceLauncher)

let consumerDir = ''
let workDir = ''
/** The consumer script's JSON verdict (see its source below). */
let verdict: {
  launcher: string
  launcherExists: boolean
  enforcing: boolean
  wrapArgv0?: string
  enforcement?: string
  exitCode?: number | null
  stderrHasDialect?: boolean
  confineOutcome?: string
} = { launcher: '', launcherExists: false, enforcing: false }

describe.skipIf(!packable)('sandbox-local: packed-tarball distribution (publish-path rehearsal)', () => {
  beforeAll(async () => {
    const packDest = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
    consumerDir = mkdtempSync(join(tmpdir(), 'dsh-packed-consumer-'))
    workDir = mkdtempSync(join(tmpdir(), 'dsh-packed-work-'))

    const nativePackDest = join(packDest, 'native')
    const nativePack = spawnSync('node', ['./scripts/pack-release.mjs', nativePackDest, '--current-platform-only'], {
      cwd: nativeDir,
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(nativePack.status, `native pack failed:\n${nativePack.stdout}\n${nativePack.stderr}`).toBe(0)

    const nativeTarballs = readFileSync(join(nativePackDest, 'publish-order.txt'), 'utf8')
      .trim()
      .split('\n')
      .map(tarball => join(nativePackDest, tarball))

    // Derive the current runtime closure so a newly introduced workspace
    // dependency cannot fall through to an unpublished registry version.
    const workspaceClosure = packedWorkspaceClosure(
      '@deepseek-ai/dsh-sandbox-local',
      readWorkspacePackages(repoRoot),
    ).filter(member => !member.name.startsWith(NATIVE_PACKAGE_PREFIX))

    // Pack each harness closure member with the exact bytes publish would upload.
    const tarballs: string[] = []
    for (const pkg of workspaceClosure) {
      const pack = spawnSync('pnpm', ['pack', '--pack-destination', packDest], {
        cwd: pkg.directory,
        encoding: 'utf8',
        timeout: 120_000,
      })
      expect(pack.status, `pnpm pack failed for ${pkg.name}:\n${pack.stdout}\n${pack.stderr}`).toBe(0)
      const lines = pack.stdout.trim().split('\n')
      tarballs.push(lines[lines.length - 1] as string)
    }
    tarballs.push(...nativeTarballs)

    // Peer ranges resolve to the tarballs, the framework peer included. Do not omit optional
    // dependencies because the launcher selects its OS/CPU package through one.
    writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ name: 'dsh-packed-consumer', private: true, type: 'module' }))
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...tarballs], {
      cwd: consumerDir,
      encoding: 'utf8',
      timeout: 300_000,
    })
    expect(install.status, `npm install failed:\n${install.stdout}\n${install.stderr}`).toBe(0)

    // The consumer script runs under PLAIN node against the installed
    // packages and reports a JSON verdict; every assertion happens back in
    // the test. bwrap is forced off so the wrap must select the INSTALLED
    // launcher; a non-enforcing kernel must surface the fail-closed error.
    writeFileSync(join(consumerDir, 'consumer.mjs'), `
      import { spawnSync } from 'node:child_process'
      import { existsSync } from 'node:fs'
      import { Context } from '@deepseek-ai/cordis'
      import { launcherPath } from '@deepseek-ai/node-addon-system/landlock-run'
      import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
      const ctx = new Context()
      await ctx.plugin(LocalSandboxProvider, {})
      const sandbox = ctx.sandbox
      sandbox.internals = { probeBwrap: () => false }
      const launcher = launcherPath()
      const probe = spawnSync(launcher, ['--probe'], { encoding: 'utf8', timeout: 5000 })
      const out = { launcher, launcherExists: existsSync(launcher), enforcing: probe.status === 0 }
      const workdir = process.argv[2]
      if (out.enforcing) {
        const confined = await sandbox.confine(['bash', '-c', \`echo hi > \${workdir}/denied.txt\`], { mode: 'read-only', workspaceRoot: workdir })
        out.wrapArgv0 = confined.argv[0]
        out.enforcement = confined.enforcement
        const run = spawnSync(confined.argv[0], confined.argv.slice(1), { encoding: 'utf8', timeout: 30000 })
        out.exitCode = run.status
        out.stderrHasDialect = /permission denied/i.test(run.stderr)
      } else {
        try {
          await sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: workdir })
          out.confineOutcome = 'wrapped'
        } catch (error) {
          out.confineOutcome = error?.code === 'SANDBOX_UNAVAILABLE' ? 'fail-closed' : String(error)
        }
      }
      console.log(JSON.stringify(out))
    `)
    const consumer = spawnSync('node', ['consumer.mjs', workDir], { cwd: consumerDir, encoding: 'utf8', timeout: 60_000 })
    expect(consumer.status, `consumer script failed:\n${consumer.stdout}\n${consumer.stderr}`).toBe(0)
    verdict = JSON.parse(consumer.stdout.trim().split('\n').pop() as string) as typeof verdict
  }, 480_000)

  afterAll(async () => {
    await Promise.all([consumerDir, workDir].filter(Boolean).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('installs this checkout\'s launcher for the host: present, executable, byte-identical, and right ELF arch', () => {
    const installed = join(consumerDir, 'node_modules', ...platformPackageName.split('/'), 'bin', 'landlock-run')
    expect(existsSync(installed), 'platform package missing from the installed tree').toBe(true)
    // A tarball or extraction step that strips the mode bit would leave the
    // probe failing exactly like a non-enforcing kernel — assert it apart.
    expect(() => { accessSync(installed, constants.X_OK) }, 'installed launcher is not executable').not.toThrow()
    expect(readFileSync(installed), 'installed launcher bytes').toEqual(readFileSync(sourceLauncher))
    expect(readFileSync(installed).readUInt16LE(18), 'ELF e_machine').toBe(E_MACHINE)
  })

  it('the installed provider resolves the launcher INSIDE the consumer node_modules platform package', () => {
    expect(verdict.launcher)
      .toBe(join(consumerDir, 'node_modules', ...platformPackageName.split('/'), 'bin', 'landlock-run'))
  })

  it('confines through the installed launcher (enforcing kernel) or fails closed (non-enforcing) — never unconfined', async () => {
    // Fail-closed is only the acceptable outcome when the installed binary
    // IS present and executable and the kernel merely does not enforce —
    // the first test pins that apart, so nothing hides behind this branch.
    expect(verdict.launcherExists, 'installed launcher missing').toBe(true)
    if (verdict.enforcing) {
      expect(verdict.wrapArgv0).toBe(verdict.launcher)
      expect(['full', 'partial']).toContain(verdict.enforcement)
      expect(verdict.exitCode).not.toBe(0)
      expect(verdict.stderrHasDialect, 'kernel denial text must match the advertised dialect').toBe(true)
      expect(existsSync(join(workDir, 'denied.txt'))).toBe(false)
    } else {
      expect(verdict.confineOutcome).toBe('fail-closed')
    }
  })
})
