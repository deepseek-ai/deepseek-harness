/** Profile package management, manifest-only bundle selection, and explicit, exact-version compatibility approvals. */
import { bundleManifest, runPluginCommand, runProfilePnpm, setProfileVersionExemption, type PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import { INSTALL_ANCHOR } from './profile-boot.ts'
import {
  assertBundlePlatform, evaluatePluginCompatibility, initProfile, pluginCompatibilityWarning, readProfileCompatibility,
  readProfileManifest, readProfileVersionExemptions, resolveProfileDir, writeProfileBundles, type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES, DEFAULT_PROFILE_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

function requireDesktopProfile(dir: string): void {
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error('Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.')
  }
}

/** Parse only DSH-owned commands; all other arguments remain pnpm's responsibility. */
async function versionCommand(profile: string, args: readonly string[]): Promise<number | undefined> {
  const [command, ...rest] = args
  if (command !== 'allow-version' && command !== 'revoke-version' && command !== 'version-exemptions') return undefined
  try {
    let packageVersion: string | undefined
    let runtimeVersion: string | undefined
    let acceptRisk = false
    const argumentsIterator = rest.values()
    for (const argument of argumentsIterator) {
      if (argument === '--accept-risk' && command === 'allow-version' && !acceptRisk) acceptRisk = true
      else if (argument === '--dsh-version' && runtimeVersion === undefined) runtimeVersion = argumentsIterator.next().value
      else if (argument.startsWith('--dsh-version=') && runtimeVersion === undefined) runtimeVersion = argument.slice('--dsh-version='.length)
      else if (!argument.startsWith('-') && packageVersion === undefined) packageVersion = argument
      else throw new Error(`unexpected argument ${JSON.stringify(argument)}`)
    }
    if (command === 'version-exemptions' && rest.length > 0) throw new Error('usage: dsh plugin version-exemptions')
    let request: { packageVersion: string; runtimeVersion: string } | undefined
    if (command !== 'version-exemptions') {
      if (packageVersion === undefined || runtimeVersion === undefined) {
        throw new Error(`usage: dsh plugin ${command} <package@version> --dsh-version <exact>${command === 'allow-version' ? ' --accept-risk' : ''}`)
      }
      request = { packageVersion, runtimeVersion }
    }
    if (command === 'allow-version') {
      process.stderr.write('dsh: warning: allowing incompatible plugin versions can break the application or corrupt data. Approval applies only to the exact package and DSH versions.\n')
    }
    const dir = resolveProfileDir(profile)
    if (profile !== 'desktop') await mkdir(dir, { recursive: true })
    await withFileLock(join(dir, 'package.json'), async () => {
      if (profile === 'desktop') requireDesktopProfile(dir)
      else if (!existsSync(join(dir, 'package.json'))) initProfile(dir, PROFILE_TEMPLATES[profile]?.bundles ?? DEFAULT_PROFILE_BUNDLES)
      if (request === undefined) {
        const { exemptions, warnings } = readProfileCompatibility(dir)
        for (const warning of warnings) process.stderr.write(`dsh: warning: ${warning}\n`)
        process.stdout.write(JSON.stringify(exemptions, undefined, 2) + '\n')
      } else {
        await setProfileVersionExemption(dir, request.packageVersion, request.runtimeVersion, command === 'allow-version', acceptRisk)
        process.stdout.write(`dsh: ${command === 'allow-version' ? 'allowed' : 'revoked'} ${request.packageVersion} for DSH ${request.runtimeVersion}\n`)
      }
    }, { waitMs: 120000 })
    return 0
  } catch (error) {
    process.stderr.write(`dsh: ${String(error)}\n`)
    return 1
  }
}

/**
 * Select or deselect installed bundles by editing `dsh.profile.bundles` alone, the way the Plugins page switch does;
 * pnpm never runs. `enable` admits a bundle the installation ships or the profile installed after its platform and
 * version checks pass; `disable` removes a selection. Bundles of the profile's shipped template are refused.
 */
async function selectionCommand(profile: string, args: readonly string[]): Promise<number | undefined> {
  const [command, ...names] = args
  if (command !== 'enable' && command !== 'disable') return undefined
  try {
    if (names.length === 0 || names.some(name => name.startsWith('-'))) throw new Error(`usage: dsh plugin ${command} <bundle...>`)
    const template = PROFILE_TEMPLATES[profile]?.bundles ?? DEFAULT_PROFILE_BUNDLES
    const dir = resolveProfileDir(profile)
    if (profile !== 'desktop') await mkdir(dir, { recursive: true })
    await withFileLock(join(dir, 'package.json'), () => {
      if (profile === 'desktop') requireDesktopProfile(dir)
      else if (!existsSync(join(dir, 'package.json'))) initProfile(dir, template)
      const manifest = readProfileManifest('dsh', dir)
      const previous = manifest.dsh?.profile?.bundles ?? []
      const bundles = [...previous]
      for (const name of names) {
        if (template.includes(name)) throw new Error(`${name} is a bundle of the ${profile} profile template and cannot be ${command}d`)
        if (command === 'disable') {
          const index = bundles.indexOf(name)
          if (index >= 0) bundles.splice(index, 1)
          continue
        }
        let metadata: ReturnType<typeof bundleManifest>
        try {
          metadata = bundleManifest(name, dir, INSTALL_ANCHOR)
        } catch (error) {
          throw new Error(`${name} is not installed: run 'dsh plugin --profile ${profile} add ${name}', or enable a bundle this installation ships`, { cause: error })
        }
        if (metadata === undefined) throw new Error(`${name} declares no dsh.bundle; only bundles can be enabled`)
        assertBundlePlatform(metadata.dsh?.bundle?.platforms, process.platform)
        const issue = evaluatePluginCompatibility(metadata, readProfileVersionExemptions(dir))
        if (issue !== undefined && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue))
        if (!bundles.includes(name)) bundles.push(name)
      }
      if (JSON.stringify(bundles) === JSON.stringify(previous)) {
        process.stdout.write(`dsh: profile ${profile} already has ${names.join(', ')} ${command}d\n`)
        return Promise.resolve()
      }
      writeProfileBundles(dir, manifest, bundles)
      process.stdout.write(`dsh: ${command}d ${names.join(', ')} in profile ${profile}; restart the profile to apply\n`)
      return Promise.resolve()
    }, { waitMs: 120000 })
    return 0
  } catch (error) {
    process.stderr.write(`dsh: ${String(error)}\n`)
    return 1
  }
}

/** Run package management for a profile.
 * @param profile Profile name; Desktop's reserved profile must already be initialized by the application.
 * @param args DSH exemption or bundle selection command, or pnpm arguments relative to the invoking directory.
 * @param packageManager Installation-owned executable and environment for pnpm operations.
 * @returns Zero on success; nonzero on invalid approval or package-manager failure.
 */
export async function runPlugin(profile: string, args: readonly string[], packageManager?: ProfileContext['packageManager']): Promise<number> {
  if (profile === 'desktop') {
    try { requireDesktopProfile(resolveProfileDir(profile)) } catch (error) {
      process.stderr.write(`dsh: ${String(error)}\n`)
      return 1
    }
  }
  const versionResult = await versionCommand(profile, args)
  if (versionResult !== undefined) return versionResult
  const selectionResult = await selectionCommand(profile, args)
  if (selectionResult !== undefined) return selectionResult
  const dir = resolveProfileDir(profile)
  if (existsSync(join(dir, 'package.json'))) {
    for (const warning of readProfileCompatibility(dir).warnings) process.stderr.write(`dsh: warning: ${warning}\n`)
  }
  const context = { profile, dir, installAnchor: INSTALL_ANCHOR, cwd: process.cwd() }
  const options: PackageOperationOptions = {
    ...packageManager,
    execution: 'cli',
    outputBytes: 16384,
    lockWaitMs: 120000,
    lookupTimeoutMs: 120000,
    onOutput: (text, stream) => { process[stream].write(text) },
  }
  const result = profile === 'desktop'
    ? await withFileLock(join(dir, 'package.json'), async () => {
      requireDesktopProfile(dir)
      return runProfilePnpm(context, args, options)
    }, { waitMs: 120000 })
    : await runPluginCommand(context, args, options)
  if (result.exitCode === 127) process.stderr.write('dsh: pnpm was not found; install pnpm and make it available on PATH.\n')
  for (const { name, version, runtimeVersion } of result.incompatible ?? []) {
    process.stderr.write(`dsh: to accept the risk, run: dsh plugin --profile ${profile} allow-version ${name}@${version} --dsh-version ${runtimeVersion} --accept-risk\n`)
  }
  if (result.exitCode !== 0) process.stderr.write(`dsh: plugin command failed; diagnostics: ${result.logPath}\n`)
  if (result.exitCode !== 0 && args.some(argument => /^git\+|^github:|\.git(?:#|$)/.test(argument))) {
    process.stderr.write(`dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in ${join(resolveProfileDir(profile), 'pnpm-workspace.yaml')}, then re-run\n`)
  }
  return result.exitCode
}
