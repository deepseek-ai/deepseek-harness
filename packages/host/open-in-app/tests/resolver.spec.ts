/**
 * Resolver behavior over a deterministic command runner and an in-process
 * PATH-resolution fake: per-platform locator chains, the one-pass catalog
 * resolution map, registry/desktop parsing, and launch-outcome
 * classification. Filesystem-facing locators use real temp directories; no
 * host application is touched.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { OPEN_IN_APP_CATALOG, type OpenInAppApp } from '../src/catalog.ts'
import {
  execCommand, launchDetachedApp, launchResolved, parseDesktopEntry, parseRegistryDump, resolveInternals,
  resolveLaunch, resolveOpenInAppApps, xdgDataDirectories,
  type OpenInAppInternals, type OpenInAppLauncher, type OpenInAppResolvedLaunch,
} from '../src/resolver.ts'

const TIMEOUT_MS = 5_000

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-spec-'))
  roots.push(root)
  return root
}

/** Runner resolving for the allowed argv prefixes and rejecting the rest. */
function runner(allow: (command: string, args: readonly string[]) => string | null): NativeCommandRunner {
  return (command, args) => {
    const stdout = allow(command, [...args])
    return stdout === null
      ? Promise.reject(new Error(`fixture rejects: ${command} ${args.join(' ')}`))
      : Promise.resolve({ stdout, stderr: '' })
  }
}

/** PATH-resolution fake answering from a fixed name-to-path table. */
function pathTable(entries: Record<string, string> = {}): (name: string) => Promise<string | null> {
  return name => Promise.resolve(entries[name] ?? null)
}

function byId(id: string): OpenInAppApp {
  const app = OPEN_IN_APP_CATALOG.find(entry => entry.id === id)
  if (app === undefined) throw new Error(`missing catalog id: ${id}`)
  return app
}

/** Internals baseline every call completes: a rejecting runner and an empty PATH. */
function bare(overrides: OpenInAppInternals): OpenInAppInternals {
  return { run: runner(() => null), resolveExecutable: pathTable(), ...overrides }
}

/** Hermetic Linux environment: XDG lookups stay inside the temp home. */
function linuxEnv(home: string): Readonly<Record<string, string>> {
  return { XDG_DATA_DIRS: join(home, 'xdg-empty') }
}

describe('resolveOpenInAppApps', () => {
  it('fails loud when the PATH resolver is not supplied', async () => {
    await expect(resolveOpenInAppApps(TIMEOUT_MS, { platform: 'linux' }))
      .rejects.toThrow(/resolveExecutable is required/)
  })

  it('resolves as empty on a platform without entries, touching no command or PATH lookup', async () => {
    const run = vi.fn<NativeCommandRunner>()
    const resolveExecutable = vi.fn(pathTable())
    await expect(resolveOpenInAppApps(TIMEOUT_MS, { platform: 'aix', run, resolveExecutable }))
      .resolves.toEqual(new Map())
    expect(run).not.toHaveBeenCalled()
    expect(resolveExecutable).not.toHaveBeenCalled()
  })

  it('resolves macOS entries from the known application directories, in menu order', async () => {
    const home = await tempRoot()
    const applications = join(home, 'Applications')
    const cursor = join(applications, 'Cursor.app')
    const zed = join(applications, 'Zed Preview.app')
    await mkdir(cursor, { recursive: true })
    await mkdir(zed, { recursive: true })
    const map = await resolveOpenInAppApps(TIMEOUT_MS, bare({
      platform: 'darwin', applicationRoots: [applications],
    }))
    // finder and terminal ship with the OS (fixed); cursor and the Zed
    // Preview spelling resolve from the injected application root.
    expect([...map.keys()]).toEqual(['finder', 'cursor', 'zed', 'terminal'])
    expect(map.get('cursor')).toEqual({
      launch: { kind: 'argv', command: 'open', args: ['-a', cursor] },
      icon: { kind: 'app-bundle', path: cursor },
    })
    expect(map.get('zed')?.launch).toEqual({ kind: 'argv', command: 'open', args: ['-a', zed] })
  })

  it('resolves Linux entries in-process through the PATH resolver, never spawning a lookup', async () => {
    const home = await tempRoot()
    const run = vi.fn<NativeCommandRunner>()
    const map = await resolveOpenInAppApps(TIMEOUT_MS, {
      platform: 'linux', home, env: { ...linuxEnv(home), DISPLAY: ':0' }, run,
      resolveExecutable: pathTable({ 'xdg-open': '/usr/bin/xdg-open', code: '/usr/bin/code', ghostty: '/usr/bin/ghostty' }),
    })
    expect([...map.keys()]).toEqual(['filemanager', 'vscode', 'ghostty'])
    expect(map.get('ghostty')?.launch).toEqual({ kind: 'argv', command: '/usr/bin/ghostty', args: ['--working-directory={path}'] })
    expect(run).not.toHaveBeenCalled()
  })

  it('does not offer the Linux file manager without a desktop session', async () => {
    const home = await tempRoot()
    const resolveExecutable = pathTable({ 'xdg-open': '/usr/bin/xdg-open' })
    await expect(resolveLaunch(byId('filemanager'), TIMEOUT_MS, bare({
      platform: 'linux', home, env: linuxEnv(home), resolveExecutable,
    }))).resolves.toBeNull()
    await expect(resolveLaunch(byId('filemanager'), TIMEOUT_MS, bare({
      platform: 'linux', home, env: { ...linuxEnv(home), WAYLAND_DISPLAY: 'wayland-0' }, resolveExecutable,
    }))).resolves.toEqual({ launch: { kind: 'argv', command: '/usr/bin/xdg-open', args: [] }, icon: undefined })
  })

  it('reads the Windows registry at most once per pass, sharing the view across entries', async () => {
    const root = await tempRoot()
    const code = join(root, 'apps', 'Code.exe')
    const sublime = join(root, 'apps', 'sublime_text.exe')
    await mkdir(join(root, 'apps'), { recursive: true })
    await writeFile(code, 'exe')
    await writeFile(sublime, 'exe')
    const regQueries: string[] = []
    const run = runner((command, args) => {
      if (command !== 'reg.exe') return null
      const key = String(args[1])
      regQueries.push(key)
      if (key.includes('App Paths')) {
        return [
          `${key}\\Code.exe`,
          `    (Default)    REG_SZ    ${code}`,
          `${key}\\sublime_text.exe`,
          `    (Default)    REG_SZ    "${sublime}"`,
          '',
        ].join('\r\n')
      }
      return ''
    })
    const map = await resolveOpenInAppApps(TIMEOUT_MS, bare({ platform: 'win32', env: {}, run }))
    expect(map.get('vscode')).toEqual({
      launch: { kind: 'argv', command: code, args: [] },
      icon: { kind: 'executable', path: code },
    })
    expect(map.get('sublimetext')?.launch).toMatchObject({ kind: 'argv', command: sublime })
    // One pass reads each registry root once: two App Paths roots and, for
    // the entries whose earlier locators all missed, three Uninstall roots.
    expect(regQueries.filter(key => key.includes('App Paths'))).toHaveLength(2)
    expect(regQueries.filter(key => key.includes('Uninstall'))).toHaveLength(3)
  })
})

describe('resolveLaunch locators', () => {
  it('fixed entries expand their icon source and survive without one', async () => {
    const systemRoot = 'C:/Windows'
    await expect(resolveLaunch(byId('explorer'), TIMEOUT_MS, bare({
      platform: 'win32', env: { SystemRoot: systemRoot },
    }))).resolves.toEqual({
      launch: { kind: 'shell-open' },
      icon: { kind: 'executable', path: `${systemRoot}/explorer.exe` },
    })
    // An unset ${SystemRoot} drops the icon claim, not the entry.
    await expect(resolveLaunch(byId('explorer'), TIMEOUT_MS, bare({ platform: 'win32', env: {} })))
      .resolves.toMatchObject({ launch: { kind: 'shell-open' }, icon: undefined })
    // macOS fixed entries trust their OS-shipped bundle path.
    await expect(resolveLaunch(byId('finder'), TIMEOUT_MS, bare({ platform: 'darwin', env: {} })))
      .resolves.toEqual({
        launch: { kind: 'shell-open' },
        icon: { kind: 'app-bundle', path: '/System/Library/CoreServices/Finder.app' },
      })
  })

  it('derives the Xcode bundle from xcode-select with the open -a fallback, rejecting non-bundle answers', async () => {
    const home = await tempRoot()
    const bundle = join(home, 'Xcode-beta.app')
    await mkdir(join(bundle, 'Contents', 'Developer'), { recursive: true })
    const run = runner(command => command === 'xcode-select' ? `${join(bundle, 'Contents', 'Developer')}\n` : null)
    await expect(resolveLaunch(byId('xcode'), TIMEOUT_MS, bare({ platform: 'darwin', run })))
      .resolves.toEqual({
        launch: { kind: 'argv', command: 'xed', args: [] },
        fallbackLaunch: { kind: 'argv', command: 'open', args: ['-a', bundle] },
        icon: { kind: 'app-bundle', path: bundle },
      })
    const rootAnswer = runner(command => command === 'xcode-select' ? '/\n' : null)
    await expect(resolveLaunch(byId('xcode'), TIMEOUT_MS, bare({ platform: 'darwin', run: rootAnswer })))
      .resolves.toBeNull()
    await expect(resolveLaunch(byId('xcode'), TIMEOUT_MS, bare({ platform: 'darwin' }))).resolves.toBeNull()
  })

  it('marks a resolved Windows CLI as its own icon source', async () => {
    await expect(resolveLaunch(byId('windowsterminal'), TIMEOUT_MS, bare({
      platform: 'win32', env: {}, resolveExecutable: pathTable({ wt: 'C:\\WA\\wt.exe' }),
    }))).resolves.toEqual({
      launch: { kind: 'argv', command: 'C:\\WA\\wt.exe', args: ['-d'] },
      icon: { kind: 'executable', path: 'C:\\WA\\wt.exe' },
    })
  })

  it('skips file candidates with unset variables and missing files, taking the first existing one', async () => {
    const root = await tempRoot()
    const local = join(root, 'local')
    const programFiles = join(root, 'pf')
    await mkdir(local, { recursive: true })
    // Candidate expansion is string substitution, so the resolved command
    // keeps the template's '/' separators after the expanded prefix.
    const code = `${programFiles}/Microsoft VS Code/Code.exe`
    await mkdir(join(programFiles, 'Microsoft VS Code'), { recursive: true })
    await writeFile(code, 'exe')
    // LOCALAPPDATA is set but holds no install; the ProgramFiles candidate wins.
    const found = await resolveLaunch(byId('vscode'), TIMEOUT_MS, bare({
      platform: 'win32', env: { LOCALAPPDATA: local, ProgramFiles: programFiles }, run: runner(() => ''),
    }))
    expect(found?.launch).toEqual({ kind: 'argv', command: code, args: [] })
    expect(found?.icon).toEqual({ kind: 'executable', path: code })
    // An unset ${LOCALAPPDATA} skips Cursor's only file candidate entirely.
    await expect(resolveLaunch(byId('cursor'), TIMEOUT_MS, bare({ platform: 'win32', env: {}, run: runner(() => '') })))
      .resolves.toBeNull()
  })

  it('expands ~/ against the injected home for Toolbox scripts, with no Windows icon claim on Linux', async () => {
    const home = await tempRoot()
    const script = join(home, '.local', 'share', 'JetBrains', 'Toolbox', 'scripts', 'idea')
    await mkdir(join(home, '.local', 'share', 'JetBrains', 'Toolbox', 'scripts'), { recursive: true })
    await writeFile(script, '#!/bin/sh')
    await expect(resolveLaunch(byId('intellij'), TIMEOUT_MS, bare({ platform: 'linux', home, env: linuxEnv(home) })))
      .resolves.toEqual({ launch: { kind: 'argv', command: script, args: [] }, icon: undefined })
  })

  it('scans versioned installs newest-first, skipping versions without the launcher', async () => {
    const root = await tempRoot()
    const programFiles = join(root, 'pf')
    const kept = join(programFiles, 'JetBrains', 'PyCharm 2023.3', 'bin', 'pycharm64.exe')
    await mkdir(join(programFiles, 'JetBrains', 'PyCharm 2024.1'), { recursive: true })
    await mkdir(join(programFiles, 'JetBrains', 'PyCharm 2023.3', 'bin'), { recursive: true })
    await writeFile(kept, 'exe')
    const internals = bare({ platform: 'win32', env: { ProgramFiles: programFiles }, run: runner(() => '') })
    const found = await resolveLaunch(byId('pycharm'), TIMEOUT_MS, internals)
    expect(found?.launch).toEqual({ kind: 'argv', command: kept, args: [] })
    // A scan root that does not exist resolves nothing.
    await expect(resolveLaunch(byId('webstorm'), TIMEOUT_MS, {
      ...internals, env: { ProgramFiles: join(root, 'nonesuch') },
    })).resolves.toBeNull()
    // An unset scan-root variable resolves nothing.
    await expect(resolveLaunch(byId('webstorm'), TIMEOUT_MS, { ...internals, env: {} })).resolves.toBeNull()
    // Numeric-aware ordering: '2024.1.10' outranks '2024.1.9'.
    const ten = join(programFiles, 'JetBrains', 'WebStorm 2024.1.10', 'bin', 'webstorm64.exe')
    await mkdir(join(programFiles, 'JetBrains', 'WebStorm 2024.1.9', 'bin'), { recursive: true })
    await writeFile(join(programFiles, 'JetBrains', 'WebStorm 2024.1.9', 'bin', 'webstorm64.exe'), 'exe')
    await mkdir(join(programFiles, 'JetBrains', 'WebStorm 2024.1.10', 'bin'), { recursive: true })
    await writeFile(ten, 'exe')
    const newest = await resolveLaunch(byId('webstorm'), TIMEOUT_MS, internals)
    expect(newest?.launch).toEqual({ kind: 'argv', command: ten, args: [] })
    // A root whose matching versions all lack the launcher resolves nothing
    // (goland's Uninstall records and file candidates also miss here).
    await mkdir(join(programFiles, 'JetBrains', 'GoLand 2024.2'), { recursive: true })
    await expect(resolveLaunch(byId('goland'), TIMEOUT_MS, internals)).resolves.toBeNull()
  })

  it('resolves App Paths hits only when the registered target exists on disk', async () => {
    const root = await tempRoot()
    const cursor = join(root, 'Cursor.exe')
    await writeFile(cursor, 'exe')
    const run = runner((command, args) => {
      if (command !== 'reg.exe') return null
      const key = String(args[1])
      if (!key.includes('App Paths')) return ''
      // The fixture value uses '/' so the expanded path exists on the POSIX
      // test host; expansion is string substitution either way.
      return [
        `${key}\\Cursor.exe`,
        '    (Default)    REG_EXPAND_SZ    %INSTALL_BASE%/Cursor.exe',
        '',
      ].join('\r\n')
    })
    // %INSTALL_BASE% expands against the injected environment.
    const found = await resolveLaunch(byId('cursor'), TIMEOUT_MS, bare({
      platform: 'win32', env: { INSTALL_BASE: root }, run,
    }))
    expect(found?.launch).toMatchObject({ kind: 'argv', command: `${root}/Cursor.exe` })
    expect(found?.icon).toEqual({ kind: 'executable', path: `${root}/Cursor.exe` })
    // An unexpandable registered target falls through, and the remaining
    // locators (Uninstall records, file candidates) also miss here.
    await expect(resolveLaunch(byId('cursor'), TIMEOUT_MS, bare({
      platform: 'win32', env: {}, run,
    }))).resolves.toBeNull()
    // Unreadable registry roots (reg.exe rejects) contribute nothing.
    await expect(resolveLaunch(byId('cursor'), TIMEOUT_MS, bare({ platform: 'win32', env: {} })))
      .resolves.toBeNull()
  })

  it('verifies Uninstall records through InstallLocation and falls back to the DisplayIcon executable', async () => {
    const root = await tempRoot()
    const git = join(root, 'Git')
    await mkdir(git, { recursive: true })
    await writeFile(join(git, 'git-bash.exe'), 'exe')
    const fork = join(root, 'Fork.exe')
    await writeFile(fork, 'exe')
    await mkdir(join(root, 'empty-install'), { recursive: true })
    const run = runner((command, args) => {
      if (command !== 'reg.exe') return null
      const key = String(args[1])
      if (key.includes('App Paths')) return ''
      return [
        // Git records that prove nothing come first: an unexpandable
        // location, then a location without the launcher.
        `${key}\\Git_stale`,
        '    DisplayName    REG_SZ    Git version 0.1',
        '    InstallLocation    REG_SZ    %UNSET_BASE%/git',
        `${key}\\Git_hollow`,
        '    DisplayName    REG_SZ    Git version 0.2',
        `    InstallLocation    REG_SZ    ${join(root, 'empty-install')}`,
        `${key}\\Git_is1`,
        '    DisplayName    REG_SZ    Git version 2.44.0',
        `    InstallLocation    REG_SZ    "${git}"`,
        `${key}\\ForkUnexpandable`,
        '    DisplayName    REG_SZ    Fork Beta',
        '    DisplayIcon    REG_SZ    %UNSET_ICON%/Fork.exe',
        `${key}\\Fork`,
        '    DisplayName    REG_SZ    Fork',
        `    DisplayIcon    REG_SZ    "${fork}",0`,
        `${key}\\NoUseableLauncher`,
        '    DisplayName    REG_SZ    Fork Legacy Notes',
        `${key}\\Nameless`,
        `    InstallLocation    REG_SZ    ${root}`,
        '',
      ].join('\r\n')
    })
    const internals = bare({ platform: 'win32', env: {}, run })
    const gitBash = await resolveLaunch(byId('gitbash'), TIMEOUT_MS, internals)
    expect(gitBash?.launch).toEqual({ kind: 'argv', command: join(git, 'git-bash.exe'), args: ['--cd={path}'] })
    const forkFound = await resolveLaunch(byId('fork'), TIMEOUT_MS, internals)
    expect(forkFound?.launch).toMatchObject({ kind: 'argv', command: fork })
  })

  it('resolves GitHub Desktop through its packaged CLI, skipping incomplete newer installs', async () => {
    const localAppData = await tempRoot()
    const installRoot = join(localAppData, 'GitHubDesktop')
    const complete = join(installRoot, 'app-3.3.6')
    const executable = join(complete, 'GitHubDesktop.exe')
    const cli = join(complete, 'resources', 'app', 'cli.js')
    await mkdir(join(installRoot, 'app-3.4.0', 'resources', 'app'), { recursive: true })
    await writeFile(join(installRoot, 'app-3.4.0', 'GitHubDesktop.exe'), 'incomplete')
    await mkdir(join(complete, 'resources', 'app'), { recursive: true })
    await writeFile(executable, 'exe')
    await writeFile(cli, 'cli')

    await expect(resolveLaunch(byId('github'), TIMEOUT_MS, bare({
      platform: 'win32', env: { LOCALAPPDATA: localAppData },
    }))).resolves.toEqual({
      launch: {
        kind: 'argv',
        command: executable,
        args: [cli, 'open'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      },
      icon: { kind: 'executable', path: executable },
    })

    await rm(cli)
    await expect(resolveLaunch(byId('github'), TIMEOUT_MS, bare({
      platform: 'win32', env: { LOCALAPPDATA: localAppData },
    }))).resolves.toBeNull()
    await expect(resolveLaunch(byId('github'), TIMEOUT_MS, bare({
      platform: 'win32', env: { LOCALAPPDATA: join(localAppData, 'missing') },
    }))).resolves.toBeNull()
  })

  it('falls back to the desktop entry when the CLI is off PATH, honoring TryExec and quoted Exec', async () => {
    const home = await tempRoot()
    const applications = join(home, '.local', 'share', 'applications')
    await mkdir(applications, { recursive: true })
    const kittyBin = join(home, 'bin', 'kitty')
    await mkdir(join(home, 'bin'), { recursive: true })
    await writeFile(kittyBin, 'bin')
    await writeFile(join(applications, 'kitty.desktop'), [
      '[Desktop Entry]',
      `TryExec=${kittyBin}`,
      'Exec=kitty --start-as normal %U',
      'Icon=kitty',
      '',
    ].join('\n'))
    const found = await resolveLaunch(byId('kitty'), TIMEOUT_MS, bare({ platform: 'linux', home, env: linuxEnv(home) }))
    expect(found?.launch).toEqual({ kind: 'argv', command: kittyBin, args: ['--directory'] })

    // A quoted absolute Exec command verifies on disk through its first token.
    const gnomeBin = join(home, 'bin', 'gnome-terminal-bin')
    await writeFile(gnomeBin, 'bin')
    await writeFile(join(applications, 'org.gnome.Terminal.desktop'), [
      '[Desktop Entry]',
      `Exec="${gnomeBin}" --window %U`,
      '',
    ].join('\n'))
    const viaExec = await resolveLaunch(byId('gnometerminal'), TIMEOUT_MS, bare({
      platform: 'linux', home, env: linuxEnv(home),
    }))
    expect(viaExec?.launch).toEqual({ kind: 'argv', command: gnomeBin, args: ['--working-directory={path}'] })

    // A bare Exec name resolves through the in-process PATH resolver;
    // XDG_DATA_HOME takes precedence over the home-derived default.
    const dataHome = join(home, 'xdg-data')
    await mkdir(join(dataHome, 'applications'), { recursive: true })
    await writeFile(join(dataHome, 'applications', 'org.kde.konsole.desktop'), [
      '[Desktop Entry]',
      'Exec=konsole-launcher --hold',
      '',
    ].join('\n'))
    const viaPath = await resolveLaunch(byId('konsole'), TIMEOUT_MS, bare({
      platform: 'linux', home, env: { ...linuxEnv(home), XDG_DATA_HOME: dataHome },
      resolveExecutable: pathTable({ 'konsole-launcher': '/usr/bin/konsole-launcher' }),
    }))
    expect(viaPath?.launch).toEqual({ kind: 'argv', command: '/usr/bin/konsole-launcher', args: ['--workdir'] })
  })

  it('resolves nothing from missing or unusable desktop entries', async () => {
    const home = await tempRoot()
    const applications = join(home, '.local', 'share', 'applications')
    await mkdir(applications, { recursive: true })
    const internals = bare({ platform: 'linux', home, env: linuxEnv(home) })
    // No desktop entry at all.
    await expect(resolveLaunch(byId('konsole'), TIMEOUT_MS, internals)).resolves.toBeNull()
    // A TryExec absent from disk.
    await writeFile(join(applications, 'org.kde.konsole.desktop'), [
      '[Desktop Entry]',
      `TryExec=${join(home, 'gone')}`,
      '',
    ].join('\n'))
    await expect(resolveLaunch(byId('konsole'), TIMEOUT_MS, internals)).resolves.toBeNull()
    // An empty TryExec with no Exec proves nothing.
    await writeFile(join(applications, 'org.kde.konsole.desktop'), '[Desktop Entry]\nTryExec=\n')
    await expect(resolveLaunch(byId('konsole'), TIMEOUT_MS, internals)).resolves.toBeNull()
    // No Exec/TryExec keys at all.
    await writeFile(join(applications, 'org.kde.konsole.desktop'), '[Desktop Entry]\nIcon=konsole\n')
    await expect(resolveLaunch(byId('konsole'), TIMEOUT_MS, internals)).resolves.toBeNull()
    // A bare Exec name off PATH.
    await writeFile(join(applications, 'org.kde.konsole.desktop'), '[Desktop Entry]\nExec=konsole-launcher\n')
    await expect(resolveLaunch(byId('konsole'), TIMEOUT_MS, internals)).resolves.toBeNull()
  })
})

describe('registry and desktop parsing', () => {
  it('parses localized default-value markers and ignores lines outside a key block', () => {
    const dump = [
      'ignored preamble',
      'HKEY_CURRENT_USER\\...\\App Paths\\Code.exe',
      '    (默认)    REG_SZ    C:\\Code.exe',
      '    Path    REG_EXPAND_SZ    %LOCALAPPDATA%\\Code',
      '    Flags    REG_DWORD    0x1',
      '',
    ].join('\r\n')
    const parsed = parseRegistryDump(dump)
    const values = parsed.get('HKEY_CURRENT_USER\\...\\App Paths\\Code.exe')
    expect(values?.get('(Default)')).toBe('C:\\Code.exe')
    expect(values?.get('Path')).toBe('%LOCALAPPDATA%\\Code')
    expect(values?.has('Flags')).toBe(false)
  })

  it('reads only the [Desktop Entry] section and tolerates comment and malformed lines', () => {
    expect(parseDesktopEntry([
      '# comment',
      '[Desktop Action new-window]',
      'Exec=ignored --new-window',
      '[Desktop Entry]',
      'no separator line',
      'Name=Kitty',
      'Exec=kitty %U',
      'TryExec=/usr/bin/kitty',
      'Icon=kitty',
      '',
    ].join('\n'))).toEqual({ exec: 'kitty %U', tryExec: '/usr/bin/kitty', icon: 'kitty' })
  })

  it('takes an Exec command as its quoted or bare first token, and none from blank text', () => {
    expect(execCommand(undefined)).toBeNull()
    expect(execCommand('"/opt/App Name/bin" --flag')).toBe('/opt/App Name/bin')
    expect(execCommand('kitty --directory %U')).toBe('kitty')
    expect(execCommand('   ')).toBeNull()
  })

  it('orders XDG data directories home-first with the freedesktop defaults', () => {
    const completed = { env: {}, home: '/h', resolveExecutable: pathTable() }
    // The home default goes through join(), so the expectation does too —
    // the Windows lane runs this unit over win32 separators.
    expect(xdgDataDirectories(resolveInternals(completed)))
      .toEqual([join('/h', '.local', 'share'), '/usr/local/share', '/usr/share'])
    expect(xdgDataDirectories(resolveInternals({ ...completed, env: { XDG_DATA_HOME: '/x', XDG_DATA_DIRS: '/a::/b' } })))
      .toEqual(['/x', '/a', '/b'])
  })
})

describe('launchResolved', () => {
  /** Launcher recording calls; entries in `outcomes` control each command's fate. */
  function launcher(
    calls: unknown[][], outcomes: Readonly<Record<string, 'ok' | 'fail' | 'enoent'>> = {},
  ): OpenInAppLauncher {
    return (command, args, options) => {
      calls.push([command, ...args, options])
      const outcome = outcomes[command] ?? 'ok'
      if (outcome === 'ok') return Promise.resolve()
      if (outcome === 'enoent') return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      return Promise.reject(new Error('launch fails'))
    }
  }

  const resolved: OpenInAppResolvedLaunch = { launch: { kind: 'argv', command: 'primary', args: [] } }
  const withFallback: OpenInAppResolvedLaunch = {
    launch: { kind: 'argv', command: 'primary', args: [] },
    fallbackLaunch: { kind: 'argv', command: 'fallback', args: [] },
  }

  it('appends the directory or substitutes {path} in place', async () => {
    const calls: unknown[][] = []
    await expect(launchResolved(
      { launch: { kind: 'argv', command: 'git-bash', args: ['--cd={path}'] } }, 'C:\\w\\dir', TIMEOUT_MS,
      bare({ launch: launcher(calls) }),
    )).resolves.toBe('launched')
    await expect(launchResolved(
      { launch: { kind: 'argv', command: 'code', args: [] } }, '/w/dir', TIMEOUT_MS,
      bare({ launch: launcher(calls) }),
    )).resolves.toBe('launched')
    expect(calls).toEqual([
      ['git-bash', '--cd=C:\\w\\dir', { watchMs: TIMEOUT_MS }],
      ['code', '/w/dir', { watchMs: TIMEOUT_MS }],
    ])
  })

  it('passes adapter-specific environment and Windows visibility policy', async () => {
    const calls: unknown[][] = []
    await expect(launchResolved({
      launch: {
        kind: 'argv',
        command: 'GitHubDesktop.exe',
        args: ['cli.js', 'open'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      },
    }, 'C:\\w\\repo', TIMEOUT_MS, bare({ launch: launcher(calls) }))).resolves.toBe('launched')
    expect(calls).toEqual([[
      'GitHubDesktop.exe', 'cli.js', 'open', 'C:\\w\\repo',
      { watchMs: TIMEOUT_MS, env: { ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true },
    ]])
  })

  it('opens a shell-open launch through the OS path opener, not a detached spawn', async () => {
    const spawns: unknown[][] = []
    const commands: string[][] = []
    await expect(launchResolved(
      { launch: { kind: 'shell-open' } }, 'C:\\w\\dir', TIMEOUT_MS,
      bare({
        platform: 'win32',
        launch: launcher(spawns),
        run: async (command, args) => {
          commands.push([command, ...args])
          return { stdout: '', stderr: '' }
        },
      }),
    )).resolves.toBe('launched')
    // The opener is the shipped Invoke-Item channel; the detached spawner never runs.
    expect(spawns).toEqual([])
    expect(commands).toEqual([
      ['powershell.exe', '-NoProfile', '-Command', "Invoke-Item -LiteralPath 'C:\\w\\dir'"],
    ])
  })

  it('counts a shell-open opener that outlives the watch window as launched, and a fast failure as failed', async () => {
    // A cold powershell start can outlive the window: still-running counts launched.
    await expect(launchResolved(
      { launch: { kind: 'shell-open' } }, '/w/dir', 25,
      bare({ platform: 'darwin', run: () => new Promise(() => {}) }),
    )).resolves.toBe('launched')
    // A failure inside the window is the outcome.
    await expect(launchResolved(
      { launch: { kind: 'shell-open' } }, '/w/dir', TIMEOUT_MS,
      bare({ platform: 'darwin', run: async () => { throw new Error('opener failed') } }),
    )).resolves.toBe('failed')
    // A vanished opener marks the resolution stale, like an argv launcher.
    await expect(launchResolved(
      { launch: { kind: 'shell-open' } }, '/w/dir', TIMEOUT_MS,
      bare({ platform: 'darwin', run: async () => {
        throw Object.assign(new Error('spawn open ENOENT'), { code: 'ENOENT' })
      } }),
    )).resolves.toBe('missing')
    // A late failure after the window settles nothing (already launched).
    let rejectLate: ((error: Error) => void) | undefined
    await expect(launchResolved(
      { launch: { kind: 'shell-open' } }, '/w/dir', 25,
      bare({ platform: 'darwin', run: () => new Promise((_resolve, reject) => { rejectLate = reject }) }),
    )).resolves.toBe('launched')
    rejectLate?.(new Error('late opener failure'))
  })

  it('tries the fallback when the primary fails and classifies the ways an attempt ends', async () => {
    const calls: unknown[][] = []
    await expect(launchResolved(withFallback, '/w/dir', TIMEOUT_MS, bare({
      launch: launcher(calls, { primary: 'fail' }),
    }))).resolves.toBe('launched')
    expect(calls.map(call => call[0])).toEqual(['primary', 'fallback'])

    await expect(launchResolved(resolved, '/w/dir', TIMEOUT_MS, bare({ launch: launcher([], { primary: 'fail' }) })))
      .resolves.toBe('failed')
    await expect(launchResolved(resolved, '/w/dir', TIMEOUT_MS, bare({ launch: launcher([], { primary: 'enoent' }) })))
      .resolves.toBe('missing')
    // Either tried launcher having vanished reports missing.
    await expect(launchResolved(withFallback, '/w/dir', TIMEOUT_MS, bare({
      launch: launcher([], { primary: 'enoent', fallback: 'fail' }),
    }))).resolves.toBe('missing')
    await expect(launchResolved(withFallback, '/w/dir', TIMEOUT_MS, bare({
      launch: launcher([], { primary: 'fail', fallback: 'enoent' }),
    }))).resolves.toBe('missing')
    await expect(launchResolved(withFallback, '/w/dir', TIMEOUT_MS, bare({
      launch: launcher([], { primary: 'fail', fallback: 'fail' }),
    }))).resolves.toBe('failed')
  })
})

describe('launchDetachedApp', () => {
  const node = process.execPath

  it('resolves when the child exits 0 inside the watch window', async () => {
    await expect(launchDetachedApp(node, ['-e', ''], { watchMs: TIMEOUT_MS }))
      .resolves.toBeUndefined()
  })

  it('rejects a nonzero exit inside the window', async () => {
    await expect(launchDetachedApp(node, ['-e', 'process.exit(3)'], { watchMs: TIMEOUT_MS }))
      .rejects.toThrow(/launcher exited with/)
  })

  it('rejects a signal-terminated child with the signal name', async () => {
    await expect(launchDetachedApp(
      node, ['-e', 'process.kill(process.pid, "SIGKILL"); setTimeout(() => {}, 5000)'],
      { watchMs: TIMEOUT_MS },
    )).rejects.toThrow(/launcher exited with/)
  })

  it('rejects a spawn failure, carrying the ENOENT code', async () => {
    await expect(launchDetachedApp('dsh-definitely-missing-launcher', [], { watchMs: TIMEOUT_MS }))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('counts a child that outlives the watch window as launched without killing it', async () => {
    // The child exits on its own shortly after; the launch settles at the
    // window, long before that, and never awaits or kills the process.
    const started = Date.now()
    await expect(launchDetachedApp(
      node, ['-e', 'setTimeout(() => {}, 1500)'], { watchMs: 100 },
    )).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1_400)
    // A late exit after the settled window changes nothing.
    await new Promise(resolve => setTimeout(resolve, 1_600))
  })

  it('hands the child a credential-scrubbed environment with explicit adapter entries', async () => {
    const root = await tempRoot()
    const witness = join(root, 'env.json')
    process.env.OPEN_IN_APP_SPEC_API_KEY = 'leak'
    process.env.OPEN_IN_APP_SPEC_PLAIN = 'visible'
    try {
      await launchDetachedApp(node, [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(['
        + 'process.env.OPEN_IN_APP_SPEC_API_KEY ?? null, process.env.OPEN_IN_APP_SPEC_PLAIN ?? null, '
        + 'process.env.ELECTRON_RUN_AS_NODE ?? null]))',
        witness,
      ], { watchMs: TIMEOUT_MS, env: { OPEN_IN_APP_SPEC_PLAIN: 'overridden', ELECTRON_RUN_AS_NODE: '1' } })
    } finally {
      delete process.env.OPEN_IN_APP_SPEC_API_KEY
      delete process.env.OPEN_IN_APP_SPEC_PLAIN
    }
    expect(JSON.parse(await readFile(witness, 'utf8'))).toEqual([null, 'overridden', '1'])
  })
})
