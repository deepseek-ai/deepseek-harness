import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { desktopReleasesRoot, retainDesktopCi, resolveDesktopRetentionRunner } from '../scripts/retain-desktop-ci.ts'
import { verifyRetainedDesktopRelease } from '../scripts/desktop-release-store.ts'
import { verifyDesktopArchive } from '../scripts/archive-desktop-ci.ts'
import { prepareDesktopPublication } from '../scripts/publish-desktop-ci.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function retainedFixture(target: 'win-x64' | 'mac-x64' | 'mac-arm64', qualification: 'unsigned' | 'signed' | 'notarized' | 'unnotarized') {
  const root = await mkdtemp(join(tmpdir(), 'retain-ci-'))
  roots.push(root)
  const appRoot = join(root, 'checkout')
  const config = join(root, 'packaging')
  const debug = qualification === 'unsigned' || qualification === 'unnotarized'
  const artifacts = join(appRoot, '.desktop-build', 'targets', target, debug ? `${qualification}-artifacts` : 'artifacts')
  await mkdir(artifacts, { recursive: true })
  await mkdir(join(config, 'presets'), { recursive: true })
  await writeFile(join(appRoot, 'package.json'), '{"version":"1.0.0"}')
  await writeFile(join(config, 'presets/test.env'), `DSH_DESKTOP_AUTO_UPDATE_ENV=test\nDOWNLOAD_TEST_RELEASE_ID=${'a'.repeat(32)}\n`)
  const names = debug ? (target === 'win-x64' ? [`deepseek-harness-1.0.0-win-x64-${qualification}.exe`]
    : [`deepseek-harness-1.0.0-${target}-${qualification}.dmg`, `deepseek-harness-1.0.0-${target}-${qualification}.zip`]) : target === 'win-x64'
    ? ['deepseek-harness-1.0.0-win-x64.exe', 'deepseek-harness-1.0.0-win-x64.exe.blockmap', 'win-x64-release.json', 'nightly.yml']
    : [`deepseek-harness-1.0.0-${target}.dmg`, `deepseek-harness-1.0.0-${target}.zip`, `deepseek-harness-1.0.0-${target}.zip.blockmap`, `${target}-release.json`, 'nightly-mac.yml']
  await Promise.all(names.map(name => writeFile(join(artifacts, name), 'fixture')))
  const env = {
    DSH_DESKTOP_RELEASES_DIR: '', DSH_PACKAGING_CONFIG_DIR: config, DSH_PACKAGING_PRESET: 'test', DSH_DESKTOP_TARGET_PLATFORM: target === 'win-x64' ? 'win32' : 'darwin',
    DSH_DESKTOP_TARGET_ARCH: target === 'mac-arm64' ? 'arm64' : 'x64', PACKAGE_SOURCE_REF: 'master', PACKAGE_SOURCE_SHA: 'b'.repeat(40), PACKAGE_VERSION: '1.0.0',
    PACKAGE_SIGNING: qualification === 'unsigned' ? 'unsigned' : 'signed', PACKAGE_SKIP_NOTARIZATION: qualification === 'unnotarized' ? 'true' : 'false', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
    DESKTOP_PUBLISH_RUNNERS: JSON.stringify({ dedicated: { label: 'dsh-dedicated', target: [target] } }),
    GITHUB_REPOSITORY: 'owner/repository', GITHUB_SHA: 'b'.repeat(40), RUNNER_NAME: 'dedicated',
  }
  const directory = await retainDesktopCi(env, appRoot)
  const archiveEnv = { ...env, GITHUB_RUN_ATTEMPT: '3', DESKTOP_RETAINED_DIRECTORY: directory,
    DESKTOP_PACKAGE_ATTEMPT: '2', DESKTOP_PACKAGE_RUNNER: env.RUNNER_NAME }
  return { root, debug, names, env, directory, archiveEnv }
}

const archiveScript = join(import.meta.dirname, '../scripts/archive-desktop-ci.ts')

it.runIf(process.platform === 'darwin' || process.platform === 'win32')('stores installer bytes with local DOS and absolute Unix modification times', async () => {
  const { root, directory, archiveEnv, names } = await retainedFixture('win-x64', 'signed')
  const timestamp = Date.UTC(2026, 9, 23, 8, 2, 43) / 1000
  await utimes(join(directory, 'manifest.json'), timestamp, timestamp)
  const output = join(root, 'archive-output')
  execFileSync(process.execPath, ['--import', 'tsx', archiveScript], {
    env: { ...process.env, ...archiveEnv, TZ: 'TST-3', DESKTOP_ARCHIVE_NAME: 'fixture.zip', GITHUB_OUTPUT: output, RUNNER_TEMP: root },
  })
  const path = (await readFile(output, 'utf8')).trim().slice('path='.length)
  const bytes = await readFile(path)
  const entries = unzipSync(bytes)
  expect(Object.keys(entries)).toEqual(['manifest.json', ...names])
  for (const [name, content] of Object.entries(entries)) expect(Buffer.from(content)).toEqual(await readFile(join(directory, name)))
  // UTC+3 is 11:02:43 on every test host.
  const directoryOffset = bytes.readUInt32LE(bytes.length - 22 + 16)
  expect(bytes.readUInt32LE(directoryOffset)).toBe(0x02014b50)
  const nameLength = bytes.readUInt16LE(directoryOffset + 28)
  expect(bytes.subarray(directoryOffset + 46, directoryOffset + 46 + nameLength).toString('utf8')).toBe('manifest.json')
  expect(bytes.readUInt16LE(directoryOffset + 10)).toBe(0)
  const dosTime = bytes.readUInt16LE(directoryOffset + 12)
  expect([dosTime >>> 11, (dosTime >>> 5) & 63, (dosTime & 31) * 2]).toEqual([11, 2, 42])
  const start = directoryOffset + 46 + nameLength
  const end = start + bytes.readUInt16LE(directoryOffset + 30)
  let unixTime: number | undefined
  for (let offset = start; offset < end; offset += 4 + bytes.readUInt16LE(offset + 2)) {
    if (bytes.readUInt16LE(offset) === 0x5455 && (bytes[offset + 4]! & 1)) unixTime = bytes.readUInt32LE(offset + 5)
  }
  expect(unixTime).toBe(timestamp)
})

it.runIf(process.platform === 'darwin' || process.platform === 'win32')('reports a ZIP creation failure without emitting an upload path', async () => {
  const { root, archiveEnv } = await retainedFixture('win-x64', 'signed')
  const output = join(root, 'archive-output')
  const result = spawnSync(process.execPath, ['--import', 'tsx', archiveScript], { encoding: 'utf8',
    env: { ...process.env, ...archiveEnv, RUNNER_TEMP: root, GITHUB_OUTPUT: output, DESKTOP_ARCHIVE_NAME: 'a'.repeat(256) + '.zip' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('desktop archival: ZIP creation failed')
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['../escape.zip', '-option.zip', 'missing-extension', 'missing-output'])('rejects invalid archive settings %s without emitting an upload path', async (name) => {
  const { root, archiveEnv } = await retainedFixture('win-x64', 'signed')
  const output = join(root, 'archive-output')
  const result = spawnSync(process.execPath, ['--import', 'tsx', archiveScript], { encoding: 'utf8',
    env: { ...process.env, ...archiveEnv, RUNNER_TEMP: root, GITHUB_OUTPUT: name === 'missing-output' ? '' : output,
      DESKTOP_ARCHIVE_NAME: name === 'missing-output' ? 'fixture.zip' : name, RUNNER_NAME: 'wrong-machine' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('desktop archival: invalid ZIP output settings')
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  ['mac-arm64', 'notarized'], ['mac-x64', 'notarized'], ['mac-x64', 'unnotarized'], ['win-x64', 'signed'], ['mac-arm64', 'unnotarized'], ['win-x64', 'unsigned'],
] as const)('retains the complete %s %s release without signing or upload credentials', async (target, qualification) => {
  const { debug, names, env, archiveEnv } = await retainedFixture(target, qualification)
  await verifyDesktopArchive(archiveEnv)
  await expect(verifyDesktopArchive({ ...archiveEnv, RUNNER_NAME: 'other' })).rejects.toThrow('wrong original machine')
  await expect(verifyDesktopArchive({ ...archiveEnv, DESKTOP_PACKAGE_ATTEMPT: '3' })).rejects.toThrow('original build')
  const manifest = await verifyRetainedDesktopRelease(desktopReleasesRoot(env), '123', '2')
  expect(manifest.files.map(file => file.name)).toEqual(names)
  expect(manifest.source).toMatchObject({ target, qualification })
  expect(manifest.source.publishRequested).toBeUndefined()
  const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8')
  if (debug) {
    expect(summary).toContain('不能发布到 test 或 production')
    expect(summary).not.toContain('Publish separately')
    await expect(prepareDesktopPublication({ ...env, DESKTOP_PUBLISH_ROUTE: JSON.stringify({
      runId: '123', attempt: '2', commit: env.GITHUB_SHA, runnerName: env.RUNNER_NAME, target, preset: 'test', sourceRef: 'master', channel: 'nightly',
    }) })).rejects.toThrow('重跑当前发布任务无效')
    await expect(summary).toMatchFileSnapshot(`./expected/retained-${qualification}.md`)
  } else expect(summary).toContain('Publish separately with package_run_id=123 and package_run_attempt=2')
})

it('rejects missing or ambiguous archival routing before packaging starts', () => {
  const env = { RUNNER_NAME: 'dedicated', DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' }
  expect(() => resolveDesktopRetentionRunner(env)).toThrow('DESKTOP_PUBLISH_RUNNERS is required')
  expect(() => resolveDesktopRetentionRunner({ ...env, DESKTOP_PUBLISH_RUNNERS: JSON.stringify({
    dedicated: { label: 'dsh-shared', target: 'mac-arm64' }, other: { label: 'dsh-shared', target: 'mac-arm64' },
  }) })).toThrow('unique artifact routing label')
})
