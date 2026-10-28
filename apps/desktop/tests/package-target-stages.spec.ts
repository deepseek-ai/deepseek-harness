import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { packageTarget, parseDesktopPackageInvocation } from '../scripts/package-target.ts'
import { withMacOSNotarizationProxy } from '../scripts/macos-notarization-proxy.ts'
import { packageMacOSArtifacts } from '../scripts/package-macos.ts'
import { withWindowsSigningStage } from '../scripts/windows-signing-stage.mjs'
import { prepareWindowsSignatureCacheDirectory } from '../scripts/windows-signature-cache-directory.mjs'

vi.mock('../scripts/macos-notarization-proxy.ts', () => ({
  withMacOSNotarizationProxy: vi.fn(async (_proxy: string | undefined, action: () => Promise<void>) => action()),
}))
vi.mock('../scripts/notarize-macos.mjs', () => ({ notarizeMacOS: vi.fn(async () => {}) }))
vi.mock('../scripts/package-macos.ts', () => ({ packageMacOSArtifacts: vi.fn(async () => {}) }))

vi.mock('../scripts/windows-signing-stage.mjs', () => ({
  withWindowsSigningStage: vi.fn(async (_options: object, operation: () => Promise<void>) => operation()),
}))
vi.mock('../scripts/windows-signature-cache-directory.mjs', () => ({
  prepareWindowsSignatureCacheDirectory: vi.fn(async () => {}),
  resolveWindowsSignatureCacheDirectory: vi.fn(() => 'C:\\fixture-cache'),
}))

// Keep the real orchestration and manifest reads; this suite owns no release directories or subprocesses.
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  rmSync: vi.fn(), mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn(),
}))

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

const environment = { DSH_DESKTOP_APP_ID: 'com.example.test', DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
  DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
  DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'fixture-pin', DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY: '2' }

function supervisor(failure?: string) {
  vi.stubEnv('npm_execpath', 'fixture-pnpm.cjs')
  const stages: string[] = []
  const run = { directory: 'fixture-record', finish: vi.fn(),
    run: vi.fn(async (stage: string, _executable: string, _args: readonly string[], _options: { env: NodeJS.ProcessEnv }) => {
      stages.push(stage)
      if (failure !== undefined && (stage === failure || stage.startsWith(`${failure} `))) throw new Error('stage refused')
    }) }
  return { run, stages }
}

it.each(['pack', 'runtime'] as const)('overlaps Windows preparation and waits for both before signing when %s finishes first', async (first) => {
  const { run, stages } = supervisor()
  const pack = Promise.withResolvers<undefined>()
  const runtime = Promise.withResolvers<undefined>()
  const finished = new Set<string>()
  run.run.mockImplementation(async (stage) => {
    stages.push(stage)
    if (stage.startsWith('run release:pack --family dsh ')) await pack.promise
    if (stage === 'run prepare:runtime --defer-primary-runtime-smoke') {
      await runtime.promise
      finished.add('runtime')
    }
    if (stage.startsWith('--dir native/system/packages/entry pack ')) finished.add('pack')
    if (stage === 'run sign:primary-runtime') expect([...finished].sort()).toEqual(['pack', 'runtime'])
  })
  const operation = packageTarget(parseDesktopPackageInvocation(['win-x64'], 'win32', 'x64'), environment, run)
  const outcome = operation.then(() => undefined, (error: unknown) => error)
  try {
    await vi.waitFor(() => {
      expect(stages.some(stage => stage.startsWith('run release:pack --family dsh '))).toBe(true)
      expect(stages).toContain('run prepare:runtime --defer-primary-runtime-smoke')
    })
    expect(stages).not.toContain('run sign:primary-runtime')
    ;(first === 'pack' ? pack : runtime).resolve(undefined)
    await vi.waitFor(() => { expect(finished.has(first)).toBe(true) })
    expect(stages).not.toContain('run sign:primary-runtime')
    expect(writeFileSync).not.toHaveBeenCalled()
    ;(first === 'pack' ? runtime : pack).resolve(undefined)
    expect(await outcome).toBeUndefined()
    expect(stages).toContain('run sign:primary-runtime')
    expect(writeFileSync).toHaveBeenCalledOnce()
  } finally {
    pack.resolve(undefined)
    runtime.resolve(undefined)
    await outcome
  }
})

it.each(['pack', 'runtime'] as const)('drains the other Windows preparation after %s fails without starting later packing or signing', async (failed) => {
  const { run, stages } = supervisor()
  const pack = Promise.withResolvers<undefined>()
  const runtime = Promise.withResolvers<undefined>()
  const failure = new Error(`${failed} preparation failed`)
  let settled = false
  run.run.mockImplementation(async (stage) => {
    stages.push(stage)
    if (stage.startsWith('run release:pack --family dsh ')) await pack.promise
    if (stage === 'run prepare:runtime --defer-primary-runtime-smoke') await runtime.promise
  })
  const outcome = packageTarget(parseDesktopPackageInvocation(['win-x64'], 'win32', 'x64'), environment, run).then(
    () => { settled = true; return undefined },
    (error: unknown) => { settled = true; return error },
  )
  try {
    await vi.waitFor(() => {
      expect(stages.some(stage => stage.startsWith('run release:pack --family dsh '))).toBe(true)
      expect(stages).toContain('run prepare:runtime --defer-primary-runtime-smoke')
    })
    ;(failed === 'pack' ? pack : runtime).reject(failure)
    await setImmediate()
    expect(settled).toBe(false)
    expect(writeFileSync).not.toHaveBeenCalled()
    ;(failed === 'pack' ? runtime : pack).resolve(undefined)
    expect(await outcome).toBe(failure)
    expect(stages.filter(stage => stage.startsWith('run release:pack'))).toHaveLength(1)
    expect(stages.some(stage => stage.startsWith('--dir apps/desktop-host pack'))).toBe(false)
    expect(stages.some(stage => stage.startsWith('--dir native/system'))).toBe(false)
    expect(stages.some(stage => stage.startsWith('run sign:primary-runtime'))).toBe(false)
    expect(stages.some(stage => stage.startsWith('run prepare:packages') || stage.startsWith('run prepare:dsh'))).toBe(false)
    expect(writeFileSync).not.toHaveBeenCalled()
  } finally {
    pack.resolve(undefined)
    runtime.resolve(undefined)
    await outcome
  }
})

it.each([undefined, '3'])('passes the package cache and selected compression to their subprocesses (%s)', async (level) => {
  const { run } = supervisor()
  const cache = resolve('fixture-package-cache')
  await packageTarget(parseDesktopPackageInvocation(['win-x64'], 'win32', 'x64'), {
    ...environment, DSH_DESKTOP_PACKAGE_CACHE_DIR: cache,
    ...(level === undefined ? {} : { DSH_DESKTOP_WINDOWS_COMPRESSION_LEVEL: level }),
    ELECTRON_BUILDER_COMPRESSION_LEVEL: '0',
  }, run)
  const prepare = run.run.mock.calls.find(([stage]) => stage.startsWith('run prepare:dsh'))!
  expect(prepare[3].env.DSH_DESKTOP_PACKAGE_CACHE_DIR).toBe(cache)
  const builder = run.run.mock.calls.find(([stage]) => stage.startsWith('exec electron-builder'))!
  expect(builder[3].env.ELECTRON_BUILDER_COMPRESSION_LEVEL).toBe(level ?? '0')
})

it.each([undefined, '2'])('uses bounded Windows packing while retaining signing and smoke (workers=%s)', async (workers) => {
  const { run, stages } = supervisor()
  const settings = workers === undefined ? environment : { ...environment, DSH_DESKTOP_WINDOWS_PACK_CONCURRENCY: workers }
  await packageTarget(parseDesktopPackageInvocation(['win-x64'], 'win32', 'x64'), settings, run)
  const packs = stages.filter(stage => stage.startsWith('run release:pack'))
  expect(packs).toHaveLength(2)
  for (const stage of packs) expect(stage).toContain(`--concurrency ${workers ?? '4'}`)
  expect(stages).toContain('preflight:windows-signing')
  expect(stages).toContain('run sign:primary-runtime --dsh')
  expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts')
})

it('requires one signing preflight before building, then records only the complete release', async () => {
  const { run, stages } = supervisor()
  await packageTarget(parseDesktopPackageInvocation(['win-x64'], 'win32', 'x64'), environment, run)
  expect(stages.slice(0, 2)).toEqual(['preflight:windows-signing', 'run build:official'])
  expect(stages.filter(stage => stage === 'preflight:windows-signing')).toHaveLength(1)
  expect(vi.mocked(withWindowsSigningStage).mock.calls.map(([options]) => options.stage))
    .toEqual(['preflight', 'artifacts'])
  expect(run.run.mock.calls[0]![3]).toMatchObject({ env: { DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'fixture-pin' }, timeoutMs: 60_000 })
  expect(run.run.mock.calls[1]![3].env).not.toHaveProperty('DSH_DESKTOP_WINDOWS_TOKEN_PIN')
  expect(stages.indexOf('run sign:primary-runtime --dsh')).toBeGreaterThan(stages.indexOf('run prepare:dsh --defer-runtime-smoke'))
  expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts')
  for (const call of run.run.mock.calls) {
    if (call[0].startsWith('run prepare:') || call[0].includes('smoke-packaged-runtime')) {
      expect(call[3].env).not.toHaveProperty('DSH_DESKTOP_WINDOWS_TOKEN_PIN')
      expect(call[3].env).not.toHaveProperty('DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY')
    }
    if (call[0].startsWith('run sign:primary-runtime')) {
      expect(call[3].env).toHaveProperty('DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY', '2')
    }
  }
  expect(writeFileSync).toHaveBeenCalledOnce()
  const record = JSON.parse(vi.mocked(writeFileSync).mock.calls[0]![1] as string) as { publicUrl: string }
  expect(record.publicUrl).toBe('https://updates.example.com/dsh-desk/0123456789abcdef0123456789abcdef/feeds/win-x64/')
})

it('initializes shared storage only after acquiring the preflight stage lock', async () => {
  const { run } = supervisor()
  vi.mocked(withWindowsSigningStage).mockImplementationOnce(async (_options, operation) => {
    expect(prepareWindowsSignatureCacheDirectory).not.toHaveBeenCalled()
    await operation()
    expect(prepareWindowsSignatureCacheDirectory).toHaveBeenCalledOnce()
  })
  await packageTarget(parseDesktopPackageInvocation(['win-x64'], 'win32', 'x64'), environment, run)
})

it.each(['preflight:windows-signing', 'run build:official', 'run sign:primary-runtime', 'run prepare:dsh --defer-runtime-smoke', 'run sign:primary-runtime --dsh',
  'exec tsx scripts/smoke-packaged-runtime.ts',
  'exec electron-builder --config electron-builder.config.mjs --win --x64 --publish never'])
('never continues or records a release after %s fails', async (failure) => {
  const { run, stages } = supervisor(failure)
  await expect(packageTarget(parseDesktopPackageInvocation(['win-x64'], 'win32', 'x64'), environment, run)).rejects.toThrow('stage refused')
  expect(stages.at(-1)).toBe(failure)
  expect(stages.filter(stage => stage === failure)).toHaveLength(1)
  expect(writeFileSync).not.toHaveBeenCalled()
})

it.each(['--unsigned', '--prepare-only'])('keeps %s hardware-free and creates no release record', async (mode) => {
  const { run, stages } = supervisor()
  await packageTarget(parseDesktopPackageInvocation(['win-x64', mode], 'win32', 'x64'), environment, run)
  expect(stages[0]).toBe(mode === '--unsigned' ? 'run build --profile local' : 'run build:official')
  expect(stages).not.toContain('preflight:windows-signing')
  expect(stages).not.toContain('run sign:primary-runtime')
  expect(stages).not.toContain('run sign:primary-runtime --dsh')
  expect(withWindowsSigningStage).not.toHaveBeenCalled()
  for (const call of run.run.mock.calls) expect(call[3].env).not.toHaveProperty('DSH_DESKTOP_WINDOWS_TOKEN_PIN')
  expect(writeFileSync).not.toHaveBeenCalled()
  expect(stages.includes('exec tsx scripts/smoke-packaged-runtime.ts --unsigned')).toBe(mode === '--unsigned')
})

it.each(['mac-arm64', 'mac-x64', 'win-x64'] as const)('selects branding from the signing mode for %s', async (target) => {
  const modes = [[], ['--unsigned'], ['--dir'], ['--unsigned', '--dir'], ['--prepare-only'],
    ...(target === 'win-x64' ? [] : [['--skip-notarization'], ['--skip-notarization', '--dir']])]
  for (const flags of modes) {
    const unsigned = flags.includes('--unsigned')
    const { run, stages } = supervisor()
    const platform = target === 'win-x64' ? 'win32' : 'darwin'
    const invocation = parseDesktopPackageInvocation([target, ...flags], platform,
      platform === 'darwin' ? 'arm64' : 'x64')
    await packageTarget(invocation, {
      ...environment,
      APPLE_KEYCHAIN_PROFILE: 'fixture',
      DSH_BUILD_CLIENT_PROFILE: unsigned ? 'official' : 'local',
      DSH_CLIENT_BUILD_PROFILE: unsigned ? 'official' : 'local',
      DSH_CLIENT_TITLE: 'Inherited title',
    }, run)
    const build = stages.find(stage => stage.startsWith('run build'))
    expect(build).toBe(unsigned ? 'run build --profile local' : 'run build:official')
    expect(stages.some(stage => stage.startsWith('exec tsx apps/desktop/scripts/pack-local-packages.ts'))).toBe(unsigned)
    expect(stages.some(stage => stage.startsWith('run release:pack --family dsh'))).toBe(!unsigned)
  }
})

it.each([
  ['mac-arm64', 'run build --profile local'],
  ['win-x64', 'run build --profile local'],
  ['mac-arm64', 'exec tsx apps/desktop/scripts/pack-local-packages.ts'],
  ['win-x64', 'exec tsx apps/desktop/scripts/pack-local-packages.ts'],
] as const)('stops unsigned %s packaging when %s fails', async (target, failure) => {
  const { run, stages } = supervisor(failure)
  const invocation = parseDesktopPackageInvocation([target, '--unsigned'],
    target === 'win-x64' ? 'win32' : 'darwin', target === 'win-x64' ? 'x64' : 'arm64')
  await expect(packageTarget(invocation, environment, run)).rejects.toThrow('stage refused')
  const failedAt = stages.findIndex(stage => stage.startsWith(failure))
  expect(failedAt).toBeGreaterThanOrEqual(0)
  expect(stages.slice(failedAt + 1)).toEqual(
    target === 'win-x64' && failure.startsWith('exec tsx') ? ['run prepare:runtime'] : [])
  expect(stages.some(stage => stage.startsWith('--dir apps/desktop-host pack'))).toBe(false)
  expect(writeFileSync).not.toHaveBeenCalled()
})

it('checks the assembled macOS runtime before notarizing and recording the release', async () => {
  const { run, stages } = supervisor()
  vi.mocked(packageMacOSArtifacts).mockImplementationOnce(async () => {
    expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts')
    expect(writeFileSync).not.toHaveBeenCalled()
  })
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64'], 'darwin', 'arm64'), environment, run)
  expect(packageMacOSArtifacts).toHaveBeenCalledOnce()
  expect(writeFileSync).toHaveBeenCalledOnce()
})

it.each([
  ['mac-arm64', false], ['mac-arm64', true], ['mac-x64', false], ['mac-x64', true],
] as const)('builds unsigned %s with directory=%s without Apple credentials, notarization, or a release record', async (target, directory) => {
  const { run, stages } = supervisor()
  await packageTarget(parseDesktopPackageInvocation([target, '--unsigned', ...(directory ? ['--dir'] : [])], 'darwin', 'arm64'), {
    ...environment, CSC_LINK: 'unused.p12', CSC_KEY_PASSWORD: 'unused-secret', APPLE_API_KEY: 'unused.p8',
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Unused identity', DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
  }, run)
  expect(stages.at(-2)).toBe(`exec electron-builder --config electron-builder.config.mjs --mac --${target === 'mac-arm64' ? 'arm64' : 'x64'} --publish never${directory ? ' --dir' : ''}`)
  expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts --unsigned')
  for (const call of run.run.mock.calls) {
    expect(call[3].env).toMatchObject({ DSH_DESKTOP_UNSIGNED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'DSH_DESKTOP_MACOS_SIGNING_IDENTITY', 'DSH_DESKTOP_MACOS_TEAM_ID']) {
      expect(call[3].env).not.toHaveProperty(key)
    }
  }
  expect(withMacOSNotarizationProxy).not.toHaveBeenCalled()
  expect(packageMacOSArtifacts).not.toHaveBeenCalled()
  expect(writeFileSync).not.toHaveBeenCalled()
})

it('fails unsigned macOS packaging when the assembled runtime cannot run', async () => {
  const { run, stages } = supervisor('exec tsx scripts/smoke-packaged-runtime.ts --unsigned')
  await expect(packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--unsigned'], 'darwin', 'arm64'), environment, run))
    .rejects.toThrow('stage refused')
  expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts --unsigned')
  expect(writeFileSync).not.toHaveBeenCalled()
})

it.each([false, true])('refuses macOS notarization and release records after an assembled-runtime failure (directory=%s)', async (directory) => {
  const { run } = supervisor('exec tsx scripts/smoke-packaged-runtime.ts')
  await expect(packageTarget(parseDesktopPackageInvocation(['mac-arm64', ...(directory ? ['--dir'] : [])], 'darwin', 'arm64'), environment, run))
    .rejects.toThrow('stage refused')
  expect(withMacOSNotarizationProxy).not.toHaveBeenCalled()
  expect(packageMacOSArtifacts).not.toHaveBeenCalled()
  expect(writeFileSync).not.toHaveBeenCalled()
})

it('checks macOS directory packages without writing a release record', async () => {
  const { run, stages } = supervisor()
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--dir'], 'darwin', 'arm64'), { ...environment, APPLE_KEYCHAIN_PROFILE: 'fixture' }, run)
  expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts')
  expect(packageMacOSArtifacts).not.toHaveBeenCalled()
  expect(writeFileSync).not.toHaveBeenCalled()
})

it.each([undefined, '2'])('passes macOS pack concurrency %s only to workspace packing and download routing only to download stages', async (concurrency) => {
  const { run } = supervisor()
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--prepare-only'], 'darwin', 'arm64'), {
    ...environment, DSH_DESKTOP_MACOS_PACK_CONCURRENCY: concurrency,
    DSH_DESKTOP_MACOS_DOWNLOAD_PROXY: 'http://downloads.example:8080',
    DSH_DESKTOP_MACOS_NOTARIZATION_PROXY: 'http://apple.example:8081',
  }, run)
  const calls = run.run.mock.calls
  const packs = calls.filter(call => call[0].startsWith('run release:pack'))
  expect(packs).toHaveLength(2)
  for (const call of packs) expect(call[2].slice(-2)).toEqual(['--concurrency', concurrency ?? '4'])
  for (const call of calls) {
    expect(call[3].env.HTTP_PROXY).toBe(/^run prepare:(?:runtime|dsh)$/u.test(call[0]) ? 'http://downloads.example:8080' : undefined)
  }
  expect(withMacOSNotarizationProxy).not.toHaveBeenCalled()
})

it.each([false, true])('scopes the Apple proxy around notarization (directory=%s)', async (directory) => {
  const { run } = supervisor()
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64', ...(directory ? ['--dir'] : [])], 'darwin', 'arm64'), {
    ...environment, APPLE_KEYCHAIN_PROFILE: 'fixture', DSH_DESKTOP_MACOS_NOTARIZATION_PROXY: 'http://apple.example:8081',
  }, run)
  expect(withMacOSNotarizationProxy).toHaveBeenCalledExactlyOnceWith('http://apple.example:8081', expect.any(Function), undefined, undefined, expect.any(Function))
  expect(packageMacOSArtifacts).toHaveBeenCalledTimes(directory ? 0 : 1)
  if (!directory) {
    const signing = run.run.mock.calls.findIndex(call => call[0].includes('--config.mac.notarize=false'))
    expect(signing).toBeGreaterThan(-1)
    expect(run.run.mock.invocationCallOrder[signing]).toBeLessThan(vi.mocked(withMacOSNotarizationProxy).mock.invocationCallOrder[0]!)
  }
})

it('does not write a release completion record when Apple proxy cleanup fails', async () => {
  const { run } = supervisor()
  vi.mocked(withMacOSNotarizationProxy).mockRejectedValueOnce(new Error('proxy restoration failed'))
  await expect(packageTarget(parseDesktopPackageInvocation(['mac-arm64'], 'darwin', 'arm64'), environment, run))
    .rejects.toThrow('proxy restoration failed')
  expect(writeFileSync).not.toHaveBeenCalled()
})

it.each([false, true])('keeps signing and runtime verification when notarization is skipped (directory=%s)', async (directory) => {
  const { run, stages } = supervisor()
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--skip-notarization', ...(directory ? ['--dir'] : [])], 'darwin', 'arm64'), {
    ...environment, CSC_LINK: 'signing.p12', CSC_KEY_PASSWORD: 'fixture-password',
  }, run)
  expect(stages).toContain('exec electron-builder --config electron-builder.config.mjs --mac --arm64 --publish never --dir')
  if (!directory) expect(stages.at(-2)).toContain('--mac zip')
  expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts --skip-notarization')
  expect(run.run.mock.calls.at(-2)![3].env).toMatchObject({
    DSH_DESKTOP_UNSIGNED: '0', DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: '1', CSC_LINK: 'signing.p12',
  })
  expect(withMacOSNotarizationProxy).not.toHaveBeenCalled()
  expect(packageMacOSArtifacts).not.toHaveBeenCalled()
  expect(writeFileSync).not.toHaveBeenCalled()
})

it.each(['mac-arm64', 'mac-x64'] as const)('applies ZIP compression without changing DMG settings when skipping notarization for %s', async (target) => {
  for (const level of [undefined, '3', '7']) {
    const { run } = supervisor()
    await packageTarget(parseDesktopPackageInvocation([target, '--skip-notarization'], 'darwin', 'arm64'), {
      ...environment, ELECTRON_BUILDER_COMPRESSION_LEVEL: '9',
      ...(level === undefined ? {} : { DSH_DESKTOP_MACOS_ZIP_COMPRESSION_LEVEL: level }),
    }, run)
    const builders = run.run.mock.calls.filter(call => call[0].startsWith('exec electron-builder'))
    expect(builders).toHaveLength(3)
    const [app, dmg, zip] = builders
    expect(app![0]).toContain('--dir')
    expect(dmg![0]).toContain('--mac dmg')
    expect(zip![0]).toContain('--mac zip')
    expect(app![3].env.ELECTRON_BUILDER_COMPRESSION_LEVEL).toBe('9')
    expect(dmg![3].env.ELECTRON_BUILDER_COMPRESSION_LEVEL).toBe('9')
    expect(zip![3].env.ELECTRON_BUILDER_COMPRESSION_LEVEL).toBe(level ?? '3')
    for (const call of [dmg!, zip!]) {
      expect(call[0]).toContain('--prepackaged')
      expect(call[0]).toContain('unnotarized-artifacts')
      expect(call[3].env.DSH_DESKTOP_MACOS_SKIP_NOTARIZATION).toBe('1')
      expect(call[3].env.DSH_DESKTOP_UNSIGNED).toBe('0')
    }
  }
  expect(packageMacOSArtifacts).not.toHaveBeenCalled()
  expect(withMacOSNotarizationProxy).not.toHaveBeenCalled()
  expect(writeFileSync).not.toHaveBeenCalled()
})

it('fails debugging packages when runtime verification fails', async () => {
  const failure = 'exec tsx scripts/smoke-packaged-runtime.ts --skip-notarization'
  const { run, stages } = supervisor(failure)
  await expect(packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--skip-notarization'], 'darwin', 'arm64'), environment, run))
    .rejects.toThrow('stage refused')
  expect(stages.at(-1)).toBe(failure)
  expect(writeFileSync).not.toHaveBeenCalled()
})

it('stops unnotarized ZIP packaging when the DMG stage fails', async () => {
  const failure = 'exec electron-builder --config electron-builder.config.mjs --mac dmg'
  const { run, stages } = supervisor(failure)
  await expect(packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--skip-notarization'], 'darwin', 'arm64'), environment, run))
    .rejects.toThrow('stage refused')
  expect(stages.some(stage => stage.includes('--mac zip'))).toBe(false)
  expect(stages.some(stage => stage.includes('smoke-packaged-runtime'))).toBe(false)
  expect(writeFileSync).not.toHaveBeenCalled()
})

it.each([undefined, '7'])('applies file-owned compression only to the final notarized ZIP (%s)', async (level) => {
  const { run } = supervisor()
  vi.mocked(packageMacOSArtifacts).mockImplementationOnce(async (_request, build) => {
    await build({ format: 'dmg', appPath: '/fixture/app', output: '/fixture/dmg' })
    await build({ format: 'zip', appPath: '/fixture/app', output: '/fixture/zip' })
  })
  const settings = { ...environment, ELECTRON_BUILDER_COMPRESSION_LEVEL: '9',
    ...(level === undefined ? {} : { DSH_DESKTOP_MACOS_ZIP_COMPRESSION_LEVEL: level }) }
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64'], 'darwin', 'arm64'), settings, run)
  const zip = run.run.mock.calls.find(call => call[0].includes('--mac zip'))
  const dmg = run.run.mock.calls.find(call => call[0].includes('--mac dmg'))
  expect(zip?.[3].env.ELECTRON_BUILDER_COMPRESSION_LEVEL).toBe(level ?? '3')
  expect(dmg?.[3].env.ELECTRON_BUILDER_COMPRESSION_LEVEL).toBe('9')
  expect(writeFileSync).toHaveBeenCalledOnce()
})
