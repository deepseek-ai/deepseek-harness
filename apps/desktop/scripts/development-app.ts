/** macOS development bundle that loads the current workspace through Electron. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Workspace and runtime settings captured for Launch Services cold starts. */
export interface DevelopmentAppOptions {
  readonly electron: string
  readonly appRoot: string
  readonly directory: string
  readonly home: string
  readonly userData: string
  readonly mainPort: number
  readonly rendererPort: number
  readonly hostPort: number
  readonly openDevtools: string
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/**
 * Prepare and register a disposable .app without changing the installed Electron package.
 * @param options - Current workspace, Electron binary, and private development locations.
 * @returns executable used by the supported desktop development launcher.
 */
export function prepareDevelopmentApp(options: DevelopmentAppOptions): string {
  const source = dirname(dirname(dirname(options.electron)))
  const bundle = join(options.directory, 'Harness Dev.app')
  const executable = join(bundle, 'Contents', 'MacOS', 'HarnessDev')
  const stamp = join(bundle, 'Contents', 'Resources', 'dsh-development.json')
  const launcher = developmentLauncher(options, bundle)
  const identity = JSON.stringify({ ...options, launcher, plist: readFileSync(join(source, 'Contents', 'Info.plist'), 'utf8') })
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== identity) {
    rmSync(bundle, { recursive: true, force: true })
    execFileSync('/usr/bin/ditto', [source, bundle])
    const plist = join(bundle, 'Contents', 'Info.plist')
    const values = {
      CFBundleIdentifier: `com.deepseek.harness.dev.${createHash('sha256').update(options.appRoot).digest('hex').slice(0, 12)}`,
      CFBundleName: 'Harness Dev',
      CFBundleDisplayName: 'Harness Dev',
      CFBundleExecutable: 'HarnessDev',
      CFBundleURLTypes: [{ CFBundleURLName: 'DeepSeek Harness', CFBundleURLSchemes: ['dsh'], CFBundleTypeRole: 'Viewer' }],
    }
    for (const [key, value] of Object.entries(values)) {
      execFileSync('/usr/bin/plutil', ['-replace', key, '-json', JSON.stringify(value), plist])
    }
    writeFileSync(executable, launcher, { mode: 0o755 })
    writeFileSync(stamp, identity, { mode: 0o600 })
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'pipe' })
  }
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle])
  return executable
}

/**
 * Create the development executable used by both the CLI and Launch Services.
 * @param options - Persisted development locations and debugging settings.
 * @param bundle - Generated application bundle.
 * @returns shell program with literal arguments and environment values.
 */
export function developmentLauncher(options: DevelopmentAppOptions, bundle: string): string {
  const environment = {
    DSH_HOME: options.home,
    DSH_DESKTOP_DEV_APP: '1',
    DSH_DESKTOP_HOST_INSPECT_PORT: String(options.hostPort),
    DSH_DESKTOP_OPEN_DEVTOOLS: options.openDevtools,
    ELECTRON_ENABLE_LOGGING: '1',
  }
  const args = [
    join(bundle, 'Contents', 'MacOS', 'Electron'),
    `--inspect=127.0.0.1:${String(options.mainPort)}`,
    `--remote-debugging-port=${String(options.rendererPort)}`,
    `--user-data-dir=${options.userData}`,
    options.appRoot,
  ]
  return [
    '#!/bin/sh',
    ...Object.entries(environment).map(([key, value]) => `export ${key}=${quote(value)}`),
    `cd ${quote(options.appRoot)}`,
    `exec ${args.map(quote).join(' ')} "$@"`,
    '',
  ].join('\n')
}
