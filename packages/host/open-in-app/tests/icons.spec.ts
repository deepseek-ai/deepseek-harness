/**
 * Icon extraction per platform over a deterministic command runner and real
 * temp filesystems: macOS `.icns` conversion, Windows PowerShell associated-
 * icon extraction, and Linux desktop-entry/theme lookup. No host application
 * is touched.
 */
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { OPEN_IN_APP_CATALOG, type OpenInAppApp } from '../src/catalog.ts'
import { extractAppIcon } from '../src/icons.ts'
import type { OpenInAppInternals, OpenInAppResolvedLaunch } from '../src/resolver.ts'

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

function byId(id: string): OpenInAppApp {
  const app = OPEN_IN_APP_CATALOG.find(entry => entry.id === id)
  if (app === undefined) throw new Error(`missing catalog id: ${id}`)
  return app
}

/** Internals baseline every call completes: a rejecting runner and an empty PATH. */
function bare(overrides: OpenInAppInternals): OpenInAppInternals {
  return {
    run: () => Promise.reject(new Error('fixture rejects')),
    resolveExecutable: () => Promise.resolve(null),
    ...overrides,
  }
}

/** Hermetic Linux environment: XDG lookups stay inside the temp home. */
function linuxEnv(home: string): Readonly<Record<string, string>> {
  return { XDG_DATA_DIRS: join(home, 'xdg-empty') }
}

/** A resolved launch whose icon source is the given bundle or executable. */
function withIcon(kind: 'app-bundle' | 'executable', path: string): OpenInAppResolvedLaunch {
  return { launch: { kind: 'argv', command: 'unused', args: [] }, icon: { kind, path } }
}

describe('macOS bundle icons', () => {
  async function bundleWith(icns: string | null, plist?: string): Promise<string> {
    const root = await tempRoot()
    const bundle = join(root, 'Fixture.app')
    await mkdir(join(bundle, 'Contents', 'Resources'), { recursive: true })
    if (icns !== null) await writeFile(join(bundle, 'Contents', 'Resources', icns), 'icns-bytes')
    if (plist !== undefined) await writeFile(join(bundle, 'Contents', 'Info.plist'), plist)
    return bundle
  }

  /** Runner that answers plutil with fixed JSON and makes sips write a PNG. */
  function iconRunner(plistJson: string | null): NativeCommandRunner {
    return async (command, args) => {
      if (command === 'plutil') {
        if (plistJson === null) throw new Error('no plist')
        return { stdout: plistJson, stderr: '' }
      }
      if (command === 'sips') {
        const out = args[args.length - 1]
        if (typeof out !== 'string') throw new Error('missing sips --out')
        await writeFile(out, 'png-bytes')
        return { stdout: '', stderr: '' }
      }
      throw new Error(`fixture rejects: ${command}`)
    }
  }

  it('uses the declared CFBundleIconFile, appending .icns when omitted', async () => {
    const bundle = await bundleWith('AppIcon.icns')
    const icon = await extractAppIcon(byId('cursor'), withIcon('app-bundle', bundle), TIMEOUT_MS, bare({
      platform: 'darwin', run: iconRunner(JSON.stringify({ CFBundleIconFile: 'AppIcon' })),
    }))
    expect(icon).toEqual({ bytes: Buffer.from('png-bytes'), contentType: 'image/png' })
  })

  it('scans Resources for the first .icns when the plist declares none or answers non-JSON', async () => {
    const bundle = await bundleWith('Fallback.icns')
    for (const plist of [JSON.stringify({}), 'not json']) {
      const icon = await extractAppIcon(byId('cursor'), withIcon('app-bundle', bundle), TIMEOUT_MS, bare({
        platform: 'darwin', run: iconRunner(plist),
      }))
      expect(icon?.bytes.toString()).toBe('png-bytes')
    }
  })

  it('resolves null for a missing Resources directory, no .icns, a declared icon absent from disk, and a failed conversion', async () => {
    const root = await tempRoot()
    const darwin = (run: NativeCommandRunner): OpenInAppInternals => bare({ platform: 'darwin', run })
    await expect(extractAppIcon(
      byId('cursor'), withIcon('app-bundle', join(root, 'Missing.app')), TIMEOUT_MS, darwin(iconRunner(null)),
    )).resolves.toBeNull()

    const bareBundle = await bundleWith(null)
    await expect(extractAppIcon(
      byId('cursor'), withIcon('app-bundle', bareBundle), TIMEOUT_MS, darwin(iconRunner(null)),
    )).resolves.toBeNull()

    const declaredMissing = await bundleWith(null)
    await expect(extractAppIcon(
      byId('cursor'), withIcon('app-bundle', declaredMissing), TIMEOUT_MS,
      darwin(iconRunner(JSON.stringify({ CFBundleIconFile: 'Ghost.icns' }))),
    )).resolves.toBeNull()

    const bundle = await bundleWith('AppIcon.icns')
    const noSips: NativeCommandRunner = command => command === 'plutil'
      ? Promise.resolve({ stdout: JSON.stringify({}), stderr: '' })
      : Promise.reject(new Error('no sips'))
    await expect(extractAppIcon(byId('cursor'), withIcon('app-bundle', bundle), TIMEOUT_MS, darwin(noSips)))
      .resolves.toBeNull()
  })

  it('resolves null when sips exits 0 without writing, and removes its temp directory either way', async () => {
    const bundle = await bundleWith('AppIcon.icns')
    const outs: string[] = []
    const capture = (write: boolean): NativeCommandRunner => async (command, args) => {
      if (command === 'plutil') return { stdout: JSON.stringify({}), stderr: '' }
      const out = args[args.length - 1]
      if (typeof out !== 'string') throw new Error('missing sips --out')
      outs.push(out)
      if (write) await writeFile(out, 'png-bytes')
      return { stdout: '', stderr: '' }
    }
    const written = await extractAppIcon(byId('cursor'), withIcon('app-bundle', bundle), TIMEOUT_MS, bare({
      platform: 'darwin', run: capture(true),
    }))
    expect(written?.bytes.toString()).toBe('png-bytes')
    await expect(extractAppIcon(byId('cursor'), withIcon('app-bundle', bundle), TIMEOUT_MS, bare({
      platform: 'darwin', run: capture(false),
    }))).resolves.toBeNull()
    expect(outs).toHaveLength(2)
    for (const out of outs) {
      await expect(stat(dirname(out))).rejects.toThrow()
    }
  })

  it('resolves null when the resolution carries no icon source', async () => {
    await expect(extractAppIcon(
      byId('finder'), { launch: { kind: 'argv', command: 'open', args: [] } }, TIMEOUT_MS, bare({ platform: 'darwin' }),
    )).resolves.toBeNull()
  })
})

describe('Windows executable icons', () => {
  /** Runner asserting the PowerShell extraction argv and writing the PNG. */
  function powershellRunner(outs: string[], write: boolean): NativeCommandRunner {
    return async (command, args) => {
      if (command !== 'powershell.exe') throw new Error(`fixture rejects: ${command}`)
      expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
      const script = args[5]
      const out = args[7]
      if (typeof script !== 'string' || typeof out !== 'string') throw new Error('missing script argv')
      // The generated script reached disk before the command ran.
      expect((await stat(script)).isFile()).toBe(true)
      outs.push(out)
      if (write) await writeFile(out, 'png-bytes')
      return { stdout: '', stderr: '' }
    }
  }

  it('extracts through the generated script, passing source and target as positional args', async () => {
    const outs: string[] = []
    const icon = await extractAppIcon(
      byId('vscode'), withIcon('executable', 'C:\\apps\\Code.exe'), TIMEOUT_MS,
      bare({ platform: 'win32', run: powershellRunner(outs, true) }),
    )
    expect(icon).toEqual({ bytes: Buffer.from('png-bytes'), contentType: 'image/png' })
    expect(outs).toHaveLength(1)
  })

  it('resolves null on a failed extraction and on an exit-0 run that wrote nothing, cleaning up its temp directory', async () => {
    await expect(extractAppIcon(
      byId('vscode'), withIcon('executable', 'C:\\apps\\Code.exe'), TIMEOUT_MS, bare({ platform: 'win32' }),
    )).resolves.toBeNull()

    const outs: string[] = []
    await expect(extractAppIcon(
      byId('vscode'), withIcon('executable', 'C:\\apps\\Code.exe'), TIMEOUT_MS,
      bare({ platform: 'win32', run: powershellRunner(outs, false) }),
    )).resolves.toBeNull()
    expect(outs).toHaveLength(1)
    for (const out of outs) {
      await expect(stat(dirname(out))).rejects.toThrow()
    }
  })
})

describe('Linux desktop-entry icons', () => {
  async function desktopHome(icon: string): Promise<string> {
    const home = await tempRoot()
    const applications = join(home, '.local', 'share', 'applications')
    await mkdir(applications, { recursive: true })
    await writeFile(join(applications, 'kitty.desktop'), `[Desktop Entry]\nExec=kitty\nIcon=${icon}\n`)
    return home
  }

  it('serves an absolute Icon= path directly, by its own media type', async () => {
    const home = await tempRoot()
    const svg = join(home, 'kitty.svg')
    await writeFile(svg, '<svg/>')
    const applications = join(home, '.local', 'share', 'applications')
    await mkdir(applications, { recursive: true })
    await writeFile(join(applications, 'kitty.desktop'), `[Desktop Entry]\nIcon=${svg}\n`)
    const icon = await extractAppIcon(byId('kitty'), { launch: { kind: 'argv', command: 'kitty', args: [] } }, TIMEOUT_MS, bare({
      platform: 'linux', home, env: linuxEnv(home),
    }))
    expect(icon).toEqual({ bytes: Buffer.from('<svg/>'), contentType: 'image/svg+xml' })
  })

  it('resolves a named icon through hicolor sizes largest-first, then scalable, then pixmaps', async () => {
    const home = await desktopHome('kitty')
    const dataHome = join(home, '.local', 'share')
    await mkdir(join(dataHome, 'icons', 'hicolor', '48x48', 'apps'), { recursive: true })
    await writeFile(join(dataHome, 'icons', 'hicolor', '48x48', 'apps', 'kitty.png'), 'png-48')
    await mkdir(join(dataHome, 'icons', 'hicolor', '256x256', 'apps'), { recursive: true })
    await writeFile(join(dataHome, 'icons', 'hicolor', '256x256', 'apps', 'kitty.png'), 'png-256')
    const internals = bare({ platform: 'linux', home, env: linuxEnv(home) })
    const kitty = byId('kitty')
    const resolved: OpenInAppResolvedLaunch = { launch: { kind: 'argv', command: 'kitty', args: [] } }
    const largest = await extractAppIcon(kitty, resolved, TIMEOUT_MS, internals)
    expect(largest?.bytes.toString()).toBe('png-256')

    // Without raster sizes, the scalable SVG serves; without hicolor at all,
    // the pixmaps directory is the last stop.
    const scalableHome = await desktopHome('kitty')
    const scalableData = join(scalableHome, '.local', 'share')
    await mkdir(join(scalableData, 'icons', 'hicolor', 'scalable', 'apps'), { recursive: true })
    await writeFile(join(scalableData, 'icons', 'hicolor', 'scalable', 'apps', 'kitty.svg'), '<svg/>')
    const scalable = await extractAppIcon(kitty, resolved, TIMEOUT_MS, bare({
      platform: 'linux', home: scalableHome, env: linuxEnv(scalableHome),
    }))
    expect(scalable?.contentType).toBe('image/svg+xml')

    const pixmapHome = await desktopHome('kitty')
    const pixmapData = join(pixmapHome, '.local', 'share')
    await mkdir(join(pixmapData, 'pixmaps'), { recursive: true })
    await writeFile(join(pixmapData, 'pixmaps', 'kitty.png'), 'pixmap')
    const pixmap = await extractAppIcon(kitty, resolved, TIMEOUT_MS, bare({
      platform: 'linux', home: pixmapHome, env: linuxEnv(pixmapHome),
    }))
    expect(pixmap?.bytes.toString()).toBe('pixmap')
  })

  it('resolves null without a desktop entry, without an Icon key, for an unfindable name, and for a spec without a desktop id', async () => {
    const empty = await tempRoot()
    const internals = (home: string): OpenInAppInternals => bare({ platform: 'linux', home, env: linuxEnv(home) })
    const resolved: OpenInAppResolvedLaunch = { launch: { kind: 'argv', command: 'kitty', args: [] } }
    await expect(extractAppIcon(byId('kitty'), resolved, TIMEOUT_MS, internals(empty))).resolves.toBeNull()

    const noIcon = await tempRoot()
    const applications = join(noIcon, '.local', 'share', 'applications')
    await mkdir(applications, { recursive: true })
    await writeFile(join(applications, 'kitty.desktop'), '[Desktop Entry]\nExec=kitty\n')
    await expect(extractAppIcon(byId('kitty'), resolved, TIMEOUT_MS, internals(noIcon))).resolves.toBeNull()

    const unfindable = await desktopHome('kitty')
    await expect(extractAppIcon(byId('kitty'), resolved, TIMEOUT_MS, internals(unfindable))).resolves.toBeNull()

    // An absolute Icon= path with an unservable media type stays a 404.
    const xpmHome = await tempRoot()
    const xpm = join(xpmHome, 'kitty.xpm')
    await writeFile(xpm, 'xpm')
    const xpmApplications = join(xpmHome, '.local', 'share', 'applications')
    await mkdir(xpmApplications, { recursive: true })
    await writeFile(join(xpmApplications, 'kitty.desktop'), `[Desktop Entry]\nIcon=${xpm}\n`)
    await expect(extractAppIcon(byId('kitty'), resolved, TIMEOUT_MS, internals(xpmHome))).resolves.toBeNull()

    // filemanager (xdg-open) declares no desktop entry to read an icon from.
    await expect(extractAppIcon(byId('filemanager'), resolved, TIMEOUT_MS, internals(empty))).resolves.toBeNull()
  })
})
