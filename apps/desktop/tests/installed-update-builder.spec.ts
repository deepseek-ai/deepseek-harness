import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createInstalledUpdateRun } from '../scripts/installed-update-qualification.ts'
import { prepareInstalledUpdateBootstrap } from '../scripts/prepare-installed-update-bootstrap.ts'
import { prepareInstalledUpdateApplication, verifyInstalledUpdateApplication } from '../scripts/prepare-installed-update-application.ts'
import { createInstalledUpdateBuilderConfig } from '../scripts/installed-update-builder.ts'
import { runtimeFixture } from './runtime-fixture.ts'
import { writeDesktopRuntime } from '../src/runtime-tree.ts'

vi.mock('../scripts/windows-sign.mjs', () => ({
  createWindowsTokenSigner: () => () => { throw new Error('test must not invoke hardware signing') },
  installWindowsNsisBootstrapSigner: () => undefined,
  resolveWindowsUpdatePublisher: () => 'CN=Fixture,O=Fixture,C=CN',
  scrubWindowsSigningEnvironment: (environment: NodeJS.ProcessEnv) => environment,
}))

const versions = ['0.1.6-nightly.20260914.1', '0.1.6-nightly.20260914.2'] as const
const environment = { DSH_DESKTOP_AUTO_UPDATE_ENV: 'test', DOWNLOAD_TEST_ORIGIN: 'https://download-test.deepseek.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
  DOWNLOAD_TEST_COS_BUCKET: 'bj-toc-download-test-1320056602' }
const require = createRequire(import.meta.url)
const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js') as {
  validateConfiguration: (config: object, logger: { isEnabled: false }) => Promise<void>
}

async function fixture<T>(body: (manifest: string, source: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-update-builder-'))
  try {
    const run = await createInstalledUpdateRun(root, versions, { version: '0.1.5-rc.2', commit: 'a'.repeat(40), dirtyFiles: [] })
    const manifest = join(run.root, 'run.json')
    await prepareInstalledUpdateBootstrap(manifest)
    const source = join(root, 'app')
    await mkdir(join(source, 'lib'), { recursive: true })
    await mkdir(join(source, 'renderer'))
    for (const file of ['main.js', 'preload-app.cjs', 'preload-mandatory.cjs', 'preload-update-dialog.cjs']) {
      await writeFile(join(source, 'lib', file), '// inert fixture\n')
    }
    await writeFile(join(source, 'renderer', 'index.html'), '<p>fixture</p>')
    await writeFile(join(source, '.env.windows'), 'must-not-copy')
    for (const version of versions) {
      const dsh = join(run.root, version, 'dsh')
      const runtime = runtimeFixture(dsh, version)
      writeDesktopRuntime(dsh, runtime.release, runtime.sharedPackages.map(entry => entry.name), { platform: 'win32', arch: 'x64' })
    }
    return await body(manifest, source)
  } finally { await rm(root, { recursive: true, force: true }) }
}

describe('installed-update application inputs and builder configuration', () => {
  it('freezes shipped files once without copying credentials or claiming dependency and boot qualification', async () => {
    await fixture(async (manifest, source) => {
      expect(await prepareInstalledUpdateApplication(manifest, source))
        .toMatchObject({ dependenciesFrozen: false, signed: false, bootTested: false })
      const directory = await verifyInstalledUpdateApplication(join(manifest, '..'))
      expect((await readdir(directory)).sort()).toEqual(['installed-update-identity.mjs', 'lib', 'qualification-bootstrap.mjs', 'renderer'])
      await writeFile(join(source, 'lib/main.js'), '// later checkout\n')
      expect(await readFile(join(directory, 'lib/main.js'), 'utf8')).toBe('// inert fixture\n')
      await expect(prepareInstalledUpdateApplication(manifest, source)).rejects.toMatchObject({ code: 'EEXIST' })
    })
  })

  it.each(['modified', 'added', 'missing'] as const)('rejects %s frozen application bytes', async (failure) => {
    await fixture(async (manifest, source) => {
      await prepareInstalledUpdateApplication(manifest, source)
      const root = join(manifest, '..')
      const directory = await verifyInstalledUpdateApplication(root)
      if (failure === 'missing') await rm(join(directory, 'lib/main.js'))
      else await writeFile(join(directory, failure === 'added' ? 'lib/unrecorded.js' : 'lib/main.js'), '// invalid\n')
      await expect(verifyInstalledUpdateApplication(root)).rejects.toThrow()
    })
  })

  it('keeps signed NSIS hooks and one isolated identity/feed while selecting each private runtime and output', async () => {
    await fixture(async (manifest, source) => {
      await prepareInstalledUpdateApplication(manifest, source)
      const [first, second] = await Promise.all(versions.map(version => createInstalledUpdateBuilderConfig(manifest, version, environment)))
      expect(first!.appId).toBe(second!.appId)
      expect(first!.extraMetadata.name).toBe(second!.extraMetadata.name)
      expect(first!.files.slice(0, 2)).toEqual(second!.files.slice(0, 2))
      expect(first!.publish).toEqual(second!.publish)
      for (const [index, config] of [first!, second!].entries()) {
        await validateConfiguration(config, { isEnabled: false })
        expect(config.extraMetadata.version).toBe(versions[index])
        expect(config.extraMetadata.main).toBe('qualification-bootstrap.mjs')
        expect(config.directories.output).toBe(join(manifest, '..', versions[index]!, 'installer'))
        const dsh = join(manifest, '..', versions[index]!, 'dsh')
        expect(config.files[2]).toMatchObject({ from: dsh, to: 'dsh' })
        expect(config.files[3]).toMatchObject({ from: join(dsh, 'node_modules'), to: 'dsh/node_modules' })
        expect(config.win.forceCodeSigning).toBe(true)
        expect(config.win.signtoolOptions.publisherName).toBe('CN=Fixture,O=Fixture,C=CN')
        expect(typeof config.win.signtoolOptions.sign).toBe('function')
        expect(typeof config.beforeBuild).toBe('function')
        expect(config.nsis.include).toMatch(/scripts[\\/]installer\.nsh$/u)
        expect(config.publish[0]!.url)
          .toMatch(/^https:\/\/download-test\.deepseek\.com\/dsh-desk\/feeds\/qualification\/[a-f0-9]{24}\/win-x64\/$/u)
      }
    })
  })

  it('retains a failed preparation without a completion receipt and refuses an unrelated version', async () => {
    await fixture(async (manifest, source) => {
      await rm(join(source, 'lib/preload-app.cjs'))
      await expect(prepareInstalledUpdateApplication(manifest, source)).rejects.toThrow('rebuild Desktop')
      expect((await readdir(join(manifest, '../application'))).sort()).toEqual(['failed.json', 'started.json'])
      await expect(createInstalledUpdateBuilderConfig(manifest, '9.0.0', environment)).rejects.toThrow('outside')
    })
  })

  it.each([
    { DSH_DESKTOP_AUTO_UPDATE_ENV: 'production' },
    { DSH_DESKTOP_UNSIGNED: '1' },
    { DOWNLOAD_TEST_ORIGIN: 'https://download.deepseek.com' },
  ])('rejects incompatible qualification settings %j', async (override) => {
    await fixture(async (manifest) => {
      await expect(createInstalledUpdateBuilderConfig(manifest, versions[0], { ...environment, ...override })).rejects.toThrow('test deployment')
    })
  })
})
