import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capture, pnpmCommand } from './process.ts'
import { packedIdentity, tarballFiles } from './tarball.ts'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/**
 * Pack one manifest into a tarball shaped like `npm pack` output.
 * @returns Absolute path of the archive.
 */
async function packedTarball(name: string, version: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tarball-'))
  directories.push(directory)
  const contents = join(directory, 'package')
  await import('node:fs/promises').then(async fs => fs.mkdir(contents))
  await writeFile(join(contents, 'package.json'), JSON.stringify({ name, version }))
  await writeFile(join(contents, 'index.js'), '')
  const archive = join(directory, `${name.replaceAll('/', '-').replace('@', '')}-${version}.tgz`)
  execFileSync('tar', ['-czf', basename(archive), 'package'], { cwd: dirname(archive) })
  return archive
}

describe('release process helpers', () => {
  it('runs pnpm through a JavaScript entry, which spawnSync can start on Windows', () => {
    const [command, ...args] = pnpmCommand()
    expect(command === 'pnpm' || /node(?:\.exe)?$/iu.test(command)).toBe(true)
    if (command !== 'pnpm') expect(args[0]).toMatch(/pnpm/u)
    expect(capture(command, [...args, '--version'])).toMatch(/^\d+\.\d+\.\d+/u)
  })
})

describe('release tarball readers', () => {
  it('lists members of an archive under an absolute path', async () => {
    // GNU tar reads the colon in a Windows drive path as a remote host, so the readers run beside the archive.
    const archive = await packedTarball('@deepseek-ai/dsh-probe', '1.2.3')
    expect(tarballFiles(archive)).toEqual(expect.arrayContaining(['package/package.json', 'package/index.js']))
  })

  it('reads what an archive declares about itself', async () => {
    const archive = await packedTarball('@deepseek-ai/dsh-probe', '1.2.3')
    expect(packedIdentity(archive)).toEqual({ name: '@deepseek-ai/dsh-probe', version: '1.2.3' })
  })
})
