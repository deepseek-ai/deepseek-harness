import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createInstalledUpdateRun, readInstalledUpdateRun } from '../scripts/installed-update-qualification.ts'
import { prepareInstalledUpdateBootstrap } from '../scripts/prepare-installed-update-bootstrap.ts'
import { configureInstalledUpdateIdentity } from '../scripts/installed-update-identity.mjs'

const versions = ['0.1.6-nightly.20260914.1', '0.1.6-nightly.20260914.2'] as const
const source = { version: '0.1.5-rc.2', commit: 'a'.repeat(40), dirtyFiles: [] }

async function fixture<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-bootstrap-'))
  try { return await body(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

describe('installed-update bootstrap', () => {
  it('executes the generated entry for both versions with isolated persistent paths before main imports', async () => {
    await fixture(async (directory) => {
      const run = await createInstalledUpdateRun(directory, versions, source)
      const bootstrap = await prepareInstalledUpdateBootstrap(join(run.root, 'run.json'))
      await mkdir(join(bootstrap, 'node_modules/electron'), { recursive: true })
      await mkdir(join(bootstrap, 'lib'))
      await writeFile(join(bootstrap, 'node_modules/electron/package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }))
      await writeFile(join(bootstrap, 'node_modules/electron/index.mjs'), `
export const app = {
  paths: {},
  getAppPath: () => ${JSON.stringify(bootstrap)},
  getPath: () => ${JSON.stringify(join(directory, 'application-data'))},
  setPath(name, value) { this.paths[name] = value }
}
`)
      await writeFile(join(bootstrap, 'lib/main.js'), `
import { app } from 'electron'
console.log(JSON.stringify({ paths: app.paths, home: process.env.DSH_HOME, journals: process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR }))
`)
      const results = []
      for (const version of versions) {
        await writeFile(join(bootstrap, 'package.json'), JSON.stringify({ type: 'module', version, dshDesktopAppId: run.appId }))
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(bootstrap, 'qualification-bootstrap.mjs')], {
          windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
            DSH_HOME: 'must-not-be-used', DSH_DESKTOP_UPDATE_JOURNAL_DIR: 'must-not-be-used' },
        })
        expect(stderr).toBe('')
        results.push(JSON.parse(stdout))
      }
      const root = join(directory, 'application-data/dsh-update-qualification', run.id)
      expect(results).toEqual([0, 1].map(() => ({ paths: { userData: join(root, 'user-data'), sessionData: join(root, 'user-data') },
        home: join(root, 'dsh-home'), journals: join(root, 'journals') })))
      expect((await readdir(root)).sort()).toEqual(['dsh-home', 'journals', 'user-data'])
      await expect(prepareInstalledUpdateBootstrap(join(run.root, 'run.json'))).rejects.toMatchObject({ code: 'EEXIST' })
    })
  })

  it('refuses foreign metadata before creating any data directory or changing the environment', async () => {
    await fixture(async (directory) => {
      const env = { DSH_HOME: 'existing' }
      const app = { getPath: () => directory, setPath: (): never => { throw new Error('unexpected path change') } }
      expect(() => configureInstalledUpdateIdentity(app, { id: 'a'.repeat(24), versions },
        { version: versions[0], dshDesktopAppId: 'com.deepseek.dsh' }, env)).toThrow('identity')
      expect(await readdir(directory)).toEqual([])
      expect(env).toEqual({ DSH_HOME: 'existing' })
    })
  })

  it.each(['origin', 'bucket', 'appId', 'root', 'feedKey', 'binPrefix', 'versions', 'source'])(
    'rejects altered %s in a retained manifest', async (field) => {
      await fixture(async (directory) => {
        const run = await createInstalledUpdateRun(directory, versions, source)
        const path = join(run.root, 'run.json')
        const changed = { ...run, [field]: field === 'versions' ? [...versions].reverse() : 'unexpected' }
        await writeFile(path, JSON.stringify(changed))
        await expect(readInstalledUpdateRun(path)).rejects.toThrow()
        expect(await readdir(dirname(path))).toEqual(['run.json'])
      })
    },
  )

  it('loads the original manifest without adding credential fields to bootstrap output', async () => {
    await fixture(async (directory) => {
      const run = await createInstalledUpdateRun(directory, versions, source)
      expect(await readInstalledUpdateRun(join(run.root, 'run.json'))).toEqual(run)
      const bootstrap = await prepareInstalledUpdateBootstrap(join(run.root, 'run.json'))
      const entry = await readFile(join(bootstrap, 'qualification-bootstrap.mjs'), 'utf8')
      expect(entry).not.toContain('SECRET')
      expect(entry).not.toContain('TOKEN')
      expect(entry).toContain(run.id)
    })
  })
})
