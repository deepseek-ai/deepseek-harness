/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver row plus the adaptive chooser, and the
 * assertions observe the durable outcome — which backend and surface entries
 * the chooser mounted into the Loader store, the capability the seam then
 * serves, and that disposing the chooser removes both mounted entries again
 * (HMR safety), joining the backend's own teardown before the disposer settles.
 */

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import type { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'
import NativeDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-native'
import {
  createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot,
} from '@deepseek-ai/dsh-launch-environment'
import * as DirectoryPickerAuto from '../src/index.ts'

const renameControl = vi.hoisted(() => ({
  attempts: 0,
  failureCode: 'EPERM',
  injectedFailures: 0,
  remainingFailures: 0,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async rename(oldPath: string, newPath: string): Promise<void> {
      renameControl.attempts++
      if (renameControl.remainingFailures > 0) {
        renameControl.remainingFailures--
        renameControl.injectedFailures++
        throw Object.assign(new Error(`injected rename failure for ${newPath}`), { code: renameControl.failureCode })
      }
      await actual.rename(oldPath, newPath)
    },
  }
})

const AUTO = '@deepseek-ai/dsh-host-directory-picker-auto'
const NATIVE = '@deepseek-ai/dsh-host-directory-picker-native'
const BROWSE = '@deepseek-ai/dsh-host-directory-picker-browse'
const NATIVE_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-native'
const BROWSE_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'

/**
 * Loader-visible stand-in for a client surface package: the surfaces belong to
 * the Client program and publish browser entry points only, so a Host-face spec
 * can neither name them in a static import nor resolve them from source. What
 * the chooser owns is the mounting decision, which every case observes through
 * the Loader store; the surface's own browser contributions belong to the
 * assembled web coverage.
 *
 * @param name Surface package specifier the chooser mounts.
 * @returns A function-plugin module the Loader can mount under that specifier.
 */
function surfaceModule(name: string): unknown {
  return { name, apply: () => undefined }
}

let root: string | undefined
let fakeBin: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, fakeBin]) {
    // maxRetries absorbs teardown stragglers (e.g. an unawaited fiber's late
    // file handle) that can otherwise race the recursive scan into ENOTEMPTY.
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
  root = undefined
  fakeBin = undefined
  renameControl.attempts = 0
  renameControl.failureCode = 'EPERM'
  renameControl.injectedFailures = 0
  renameControl.remainingFailures = 0
})

/** Write a two-row cordis.yml (webserver + chooser), then boot it through the real Loader. */
async function loadComposition(
  bindHost: '127.0.0.1' | '0.0.0.0',
  options: { failSurface?: boolean; launchEnvironment?: LaunchEnvironmentSnapshot } = {},
): Promise<{ ctx: Context; configPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-directory-picker-auto-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    `    host: '${bindHost}'`,
    '    port: 0',
    `- name: '${AUTO}'`,
    '',
  ].join('\n'))

  context = new Context()
  if (options.launchEnvironment !== undefined) context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.launchEnvironment)
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    [AUTO, DirectoryPickerAuto],
    [NATIVE, NativeDirectoryPicker],
    [BROWSE, BrowseDirectoryPicker],
    [NATIVE_SURFACE, surfaceModule(NATIVE_SURFACE)],
    [BROWSE_SURFACE, surfaceModule(BROWSE_SURFACE)],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (options.failSurface === true && (specifier === NATIVE_SURFACE || specifier === BROWSE_SURFACE)) {
        throw new Error(`surface import failed: ${specifier}`)
      }
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { ctx: context, configPath }
}

/** Entry names currently present in the loader store (root tree plus subtrees). */
function entryNames(ctx: Context): string[] {
  return [...ctx.loader.entries()].map(entry => entry.options.name)
}

/** The Include tree that backs the booted `cordis.yml` file. */
function includeTree(ctx: Context): Include {
  const include = [...ctx.loader.entries()]
    .find(entry => entry.options.name === 'cordis:include')?.subtree as Include | undefined
  if (include === undefined) throw new Error('expected the root Include tree')
  return include
}

/**
 * Force every signal of an attended host on any platform: no SSH launch, a
 * display, and a PATH holding one executable chooser binary so the real
 * probe resolves identically on hosts with and without zenity/kdialog.
 */
function stubAttendedHost(): void {
  fakeBin = mkdtempSync(join(tmpdir(), 'dsh-picker-bin-'))
  const zenity = join(fakeBin, 'zenity')
  writeFileSync(zenity, '#!/bin/sh\n')
  chmodSync(zenity, 0o755)
  vi.stubEnv('PATH', fakeBin)
  vi.stubEnv('SSH_CONNECTION', '')
  vi.stubEnv('SSH_TTY', '')
  vi.stubEnv('DISPLAY', ':0')
}

describe('real Loader composition', () => {
  it.each(['project-env', 'user-env'] as const)('keeps the native backend with materialized SSH markers from %s', async (source) => {
    stubAttendedHost()
    vi.stubEnv('SSH_CONNECTION', 'stale-connection')
    vi.stubEnv('SSH_TTY', '/dev/pts/stale')
    const launchEnvironment = createLaunchEnvironmentSnapshot([
      { source, values: { SSH_CONNECTION: 'stale-connection', SSH_TTY: '/dev/pts/stale' } },
    ])
    const { ctx } = await loadComposition('127.0.0.1', { launchEnvironment })
    expect(ctx.get('directoryPicker')?.capability().kind).toBe('native')
    expect(entryNames(ctx)).toContain(NATIVE_SURFACE)
    expect(entryNames(ctx)).not.toContain(BROWSE_SURFACE)
  })

  // The 60s budget covers this file's static imports (webserver plus both
  // backend node halves through tsx), which dominate on cold caches; the
  // Loader itself resolves nothing here — `loader.internal` is a module map.
  it('mounts the native backend for an attended loopback host and unmounts it on disposal', { timeout: 60_000 }, async () => {
    stubAttendedHost()
    const { ctx, configPath } = await loadComposition('127.0.0.1')

    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(entryNames(ctx)).toContain(NATIVE)
    expect(entryNames(ctx)).toContain(NATIVE_SURFACE)
    expect(entryNames(ctx)).not.toContain(BROWSE)
    expect(entryNames(ctx)).not.toContain(BROWSE_SURFACE)
    const picker = ctx.get('directoryPicker') as DirectoryPicker
    expect(picker.capability().kind).toBe('native')
    // The mounted row lives in the Loader's in-memory root tree only — the
    // booted config file must never gain the resolved backend row.
    expect(await readFile(configPath, 'utf8')).not.toContain(NATIVE)

    // HMR safety: disposing the chooser's fiber removes the entry it created,
    // and the disposer joins the backend's teardown — the service is gone the
    // moment dispose() settles, with no further loader await.
    const autoEntry = [...ctx.loader.entries()].find(entry => entry.options.name === AUTO)!
    const backendEntry = [...ctx.loader.entries()].find(entry => entry.options.name === NATIVE)!
    const cleanupStarted = Promise.withResolvers<undefined>()
    const releaseCleanup = Promise.withResolvers<undefined>()
    onTestFinished(() => { releaseCleanup.resolve(undefined) })
    backendEntry.fiber!.ctx.effect(() => async () => {
      cleanupStarted.resolve(undefined)
      await releaseCleanup.promise
    })
    let disposed = false
    const disposal = autoEntry.fiber!.dispose().then(() => { disposed = true })
    await cleanupStarted.promise
    await Promise.resolve()
    expect(disposed).toBe(false)
    releaseCleanup.resolve(undefined)
    await disposal
    expect(entryNames(ctx)).not.toContain(NATIVE)
    expect(entryNames(ctx)).not.toContain(NATIVE_SURFACE)
    expect(ctx.get('directoryPicker')).toBeUndefined()
    // Self-disposing an include-tree entry persists `disabled: true` (loader
    // behavior, not the chooser's); await that debounced write so it cannot
    // race the temp-dir removal, and pin that the persisted row is the
    // chooser itself — the resolved backend still never reaches the file.
    // stop() drains the Include write queue, so this assertion does not depend
    // on the debounce timer racing Windows coverage load.
    await includeTree(ctx).stop()
    expect(await readFile(configPath, 'utf8')).toContain('disabled: true')
    expect(await readFile(configPath, 'utf8')).not.toContain(NATIVE)
  })

  it('mounts the browse backend under an SSH launch', { timeout: 60_000 }, async () => {
    stubAttendedHost()
    vi.stubEnv('SSH_CONNECTION', '10.0.0.2 55 10.0.0.9 22')
    const { ctx } = await loadComposition('127.0.0.1')

    expect(entryNames(ctx)).toContain(BROWSE)
    expect(entryNames(ctx)).toContain(BROWSE_SURFACE)
    expect(entryNames(ctx)).not.toContain(NATIVE)
    expect(entryNames(ctx)).not.toContain(NATIVE_SURFACE)
    const picker = ctx.get('directoryPicker') as DirectoryPicker
    expect(picker.capability().kind).toBe('browse')
  })

  it('mounts the browse backend for an all-interfaces bind even on an attended host', { timeout: 60_000 }, async () => {
    stubAttendedHost()
    const { ctx } = await loadComposition('0.0.0.0')

    expect(entryNames(ctx)).toContain(BROWSE)
    expect(entryNames(ctx)).toContain(BROWSE_SURFACE)
    expect(entryNames(ctx)).not.toContain(NATIVE)
    expect(entryNames(ctx)).not.toContain(NATIVE_SURFACE)
  })

  it('unmounts the backend when the surface entry fails to load', { timeout: 60_000 }, async () => {
    stubAttendedHost()
    const { ctx } = await loadComposition('127.0.0.1', { failSurface: true })
    const chooser = [...ctx.loader.entries()].find(entry => entry.options.name === AUTO)!
    await expect(chooser.fiber!.await()).rejects.toThrow(/directory-picker-auto: failed to load/)

    // Setup owns both entries until it returns its disposer, so a failed surface
    // must take the mounted backend with it: otherwise a retry collides with the
    // directoryPicker registration this backend already made.
    expect(entryNames(context!)).not.toContain(NATIVE)
    expect(context!.get('directoryPicker')).toBeUndefined()
  })

  it('tolerates the mounted entry being removed by the tree before the chooser unloads', { timeout: 60_000 }, async () => {
    stubAttendedHost()
    const { ctx, configPath } = await loadComposition('127.0.0.1')

    const backendEntry = [...ctx.loader.entries()].find(entry => entry.options.name === NATIVE)!
    ctx.loader.remove(backendEntry.id)
    const autoEntry = [...ctx.loader.entries()].find(entry => entry.options.name === AUTO)!
    renameControl.remainingFailures = 1
    await expect(autoEntry.fiber!.dispose()).resolves.not.toThrow()
    expect(entryNames(ctx)).not.toContain(NATIVE)
    expect(entryNames(ctx)).not.toContain(NATIVE_SURFACE)
    // Same self-dispose persistence as above: drain the Include write queue
    // deterministically before asserting the persisted row.
    await includeTree(ctx).stop()
    expect(await readFile(configPath, 'utf8')).toContain('disabled: true')
    expect(renameControl.injectedFailures).toBe(1)
    expect(renameControl.remainingFailures).toBe(0)
    expect(renameControl.attempts).toBeGreaterThanOrEqual(2)
  })

  it('reports a terminal debounced-write failure again to the teardown owner', { timeout: 60_000 }, async () => {
    stubAttendedHost()
    const { ctx } = await loadComposition('127.0.0.1')
    const autoEntry = [...ctx.loader.entries()].find(entry => entry.options.name === AUTO)!
    const include = includeTree(ctx)
    renameControl.failureCode = 'EIO'
    renameControl.remainingFailures = 1

    await autoEntry.fiber!.dispose()
    await expect.poll(() => renameControl.injectedFailures).toBe(1)
    await expect(include.stop()).rejects.toMatchObject({ code: 'EIO' })
    await expect(ctx.fiber.dispose()).resolves.not.toThrow()
    context = undefined
  })
})
