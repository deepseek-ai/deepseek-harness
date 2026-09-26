import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { createInstalledUpdateRun } from '../scripts/installed-update-qualification.ts'
import { planInstalledUpdateDistribution } from '../scripts/installed-update-distribution.ts'

const versions = ['0.1.6-nightly.20260914.1', '0.1.6-nightly.20260914.2'] as const

async function fixture<T>(body: (manifest: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-distribution-'))
  try {
    const run = await createInstalledUpdateRun(directory, versions, { version: '0.1.5-rc.2', commit: 'a'.repeat(40), dirtyFiles: [] })
    for (const version of versions) {
      const output = join(run.root, version, 'installer')
      await mkdir(output, { recursive: true })
      const filename = `deepseek-harness-${version}-win-x64.exe`
      const body = Buffer.from(`inert fixture ${version}`)
      await writeFile(join(output, filename), body)
      await writeFile(join(output, `${filename}.blockmap`), 'inert map')
      await writeFile(join(output, 'nightly.yml'), JSON.stringify({ version,
        files: [{ url: filename, size: body.length, sha512: createHash('sha512').update(body).digest('base64') }] }))
    }
    return await body(join(run.root, 'run.json'))
  } finally { await rm(directory, { recursive: true, force: true }) }
}

describe('qualification distribution file planning', () => {
  it('keeps two binary sets separate from successive bodies at one fixed feed URL without publication authority', async () => {
    await fixture(async (manifest) => {
      const [old, next] = await Promise.all(versions.map(version => planInstalledUpdateDistribution(manifest, version)))
      expect(old!.feed.url).toBe(next!.feed.url)
      expect(old!.feed.sha512).not.toBe(next!.feed.sha512)
      expect(old!.binaries.map(file => file.key)).not.toEqual(next!.binaries.map(file => file.key))
      expect(next!.binaries).toHaveLength(2)
      expect(next!.binaries.every(file => file.key.startsWith('dsh-desk/bin/qualification/'))).toBe(true)
      expect(next!.feed.key).toMatch(/^dsh-desk\/feeds\/qualification\/[a-f0-9]{24}\/win-x64\/nightly.yml$/u)
      expect(next!.publicationAuthorized).toBe(false)
      expect(next!.verified).toBe('file-integrity-only')
      expect(load(next!.feed.contents)).toMatchObject({ version: versions[1],
        files: [{ url: `https://download-test.deepseek.com/${next!.binaries[0]!.key}` }] })
    })
  })

  it.each(['changed-bytes', 'missing-map', 'foreign-url', 'wrong-version', 'legacy-hash'])(
    'rejects %s before producing any distribution plan', async (failure) => {
      await fixture(async (manifest) => {
        const plan = await planInstalledUpdateDistribution(manifest, versions[0])
        const installer = plan.binaries[0]!.path
        const metadataPath = join(installer, '..', 'nightly.yml')
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { version: string; files: { url: string }[]; sha512?: string }
        if (failure === 'changed-bytes') await writeFile(installer, 'changed')
        if (failure === 'missing-map') await rm(plan.binaries[1]!.path)
        if (failure === 'foreign-url') metadata.files[0]!.url = 'https://other.invalid/unrelated.exe'
        if (failure === 'wrong-version') metadata.version = versions[1]
        if (failure === 'legacy-hash') metadata.sha512 = 'wrong'
        await writeFile(metadataPath, JSON.stringify(metadata))
        await expect(planInstalledUpdateDistribution(manifest, versions[0])).rejects.toThrow()
      })
    },
  )
})
