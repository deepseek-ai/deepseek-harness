import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { retainDesktopRelease, retainedDesktopPath, verifyRetainedDesktopRelease, type DesktopRetainedSource } from '../scripts/desktop-release-store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-release-store-'))
  roots.push(root)
  const file = join(root, 'installer.exe')
  await writeFile(file, 'signed installer fixture')
  const source: DesktopRetainedSource = {
    repository: 'owner/repository', runId: '100', attempt: '1', commit: 'a'.repeat(40), runnerName: 'windows-runner',
    target: 'win-x64', preset: 'test', productVersion: '1.0.0', version: '1.0.0', testReleaseId: 'b'.repeat(32),
    workflowCommit: 'a'.repeat(40), sourceRef: 'master', channel: 'nightly',
    publishRequested: true, qualification: 'signed',
  }
  return { root: join(root, 'releases'), file, source }
}

it('retains independent attempts after source removal and rejects replacing an existing attempt', async () => {
  const { root, file, source } = await fixture()
  const first = await retainDesktopRelease(root, source, [file])
  const second = await retainDesktopRelease(root, { ...source, attempt: '2' }, [file])
  expect(first).not.toBe(second)
  await expect(retainDesktopRelease(root, source, [file])).rejects.toThrow(/already exists/u)
  await rm(file)
  const manifest = await verifyRetainedDesktopRelease(root, '100', '1')
  expect(manifest.source).toEqual(source)
  expect(await readFile(join(first, 'installer.exe'), 'utf8')).toBe('signed installer fixture')
})

it('detects changed bytes even when file length is unchanged', async () => {
  const { root, file, source } = await fixture()
  const directory = await retainDesktopRelease(root, source, [file])
  const path = join(directory, 'installer.exe')
  await writeFile(path, Buffer.alloc((await readFile(path)).length))
  await expect(verifyRetainedDesktopRelease(root, '100', '1')).rejects.toThrow(/changed file/u)
})

it('does not expose an incomplete copy and releases its claim after failure', async () => {
  const { root, file, source } = await fixture()
  await expect(retainDesktopRelease(root, source, [file, join(root, 'missing.zip')])).rejects.toThrow()
  await expect(verifyRetainedDesktopRelease(root, '100', '1')).rejects.toThrow()
  await retainDesktopRelease(root, source, [file])
  await expect(verifyRetainedDesktopRelease(root, '100', '1')).resolves.toMatchObject({ source })
})

it('permits only one writer for a concurrently retained attempt', async () => {
  const { root, file, source } = await fixture()
  const results = await Promise.allSettled([
    retainDesktopRelease(root, source, [file]), retainDesktopRelease(root, source, [file]),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  await expect(verifyRetainedDesktopRelease(root, '100', '1')).resolves.toMatchObject({ source })
})

it('rejects traversal and manifest identity or file inventory tampering', async () => {
  const { root, file, source } = await fixture()
  expect(() => retainedDesktopPath(root, '../100', '1')).toThrow()
  expect(() => retainedDesktopPath(root, '100', '0')).toThrow()
  const path = await retainDesktopRelease(root, source, [file])
  const manifest = await verifyRetainedDesktopRelease(root, '100', '1')
  await writeFile(join(path, 'manifest.json'), JSON.stringify({ ...manifest, source: { ...source, attempt: '2' } }))
  await expect(verifyRetainedDesktopRelease(root, '100', '1')).rejects.toThrow(/identity mismatch/u)
  await writeFile(join(path, 'manifest.json'), JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], name: '../installer.exe' }] }))
  await expect(verifyRetainedDesktopRelease(root, '100', '1')).rejects.toThrow()
})
