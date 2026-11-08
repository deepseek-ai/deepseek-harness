/** Reading a commit archive: which files are kept, which archives are refused, and how the kept files are digested. */
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { digestFiles, readArchive } from '../src/archive.ts'
import { KEPT, ROOT, SELECTION, repository, tarball, type ArchiveEntry } from './harness.ts'

const read = (archive: Buffer, maxBytes = 1_000_000) => readArchive(Readable.from([archive]), SELECTION, maxBytes)
const text = (files: Map<string, Buffer>) => Object.fromEntries([...files].map(([path, content]) => [path, content.toString()]))
const withLicense = (entries: readonly ArchiveEntry[]): Buffer => tarball([{ path: `${ROOT}/LICENSE`, content: 'MIT\n' }, ...entries])

describe('readArchive', () => {
  it('keeps the regular files under the directory and the license at their repository paths, without excluded files', async () => {
    expect(text(await read(repository()))).toEqual(KEPT)
  })

  it('reads an archive streamed in small chunks', async () => {
    const archive = repository()
    const chunks = Array.from({ length: Math.ceil(archive.length / 7) }, (_, index) => archive.subarray(index * 7, index * 7 + 7))
    expect(text(await readArchive(Readable.from(chunks), SELECTION, 1_000_000))).toEqual(KEPT)
  })

  it.each([
    ['a parent segment', `${ROOT}/skills/../../etc/passwd`],
    ['a current-directory segment', `${ROOT}/skills/./alpha/SKILL.md`],
    ['an empty segment', `${ROOT}//skills/alpha/SKILL.md`],
    ['an absolute path', '/etc/passwd'],
    // On Windows node-tar turns backslashes into slashes before the library reads the path.
    ...process.platform === 'win32' ? [] : [['a backslash', `${ROOT}/skills/alpha\\SKILL.md`]],
  ])('refuses %s anywhere in the archive and names the first unsafe entry', async (_case, path) => {
    const after = { path: `${ROOT}/skills/alpha/../../after`, content: 'x' }
    await expect(read(withLicense([{ path, content: 'x' }, after]))).rejects.toThrow(`the archive holds the unsafe path ${path}`)
  })

  it('refuses entries outside the first top-level directory', async () => {
    await expect(read(withLicense([{ path: 'other/skills/alpha/SKILL.md', content: 'x' }])))
      .rejects.toThrow(`the archive holds other/skills/alpha/SKILL.md outside its top-level directory ${ROOT}`)
  })

  it('refuses a kept path that is a link and ignores links elsewhere', async () => {
    await expect(read(withLicense([{ path: `${ROOT}/skills/alpha/SKILL.md`, type: 'SymbolicLink', linkpath: '/etc/passwd' }])))
      .rejects.toThrow('the archive holds skills/alpha/SKILL.md as a SymbolicLink, not a regular file')
    await expect(read(withLicense([{ path: `${ROOT}/skills/alpha/data`, type: 'Link', linkpath: `${ROOT}/LICENSE` }])))
      .rejects.toThrow('the archive holds skills/alpha/data as a Link, not a regular file')
    expect(text(await read(withLicense([{ path: `${ROOT}/docs/link`, type: 'SymbolicLink', linkpath: '/etc/passwd' }])))).toEqual({ LICENSE: 'MIT\n' })
  })

  it('refuses a kept path that appears twice', async () => {
    await expect(read(withLicense([{ path: `${ROOT}/LICENSE`, content: 'other\n' }]))).rejects.toThrow('the archive holds LICENSE twice')
  })

  it('accepts kept files of exactly the size bound and refuses one byte more, including one oversized file', async () => {
    const bytes = Object.values(KEPT).reduce((total, content) => total + Buffer.byteLength(content), 0)
    expect(text(await read(repository(), bytes))).toEqual(KEPT)
    await expect(read(repository(), bytes - 1)).rejects.toThrow(`the kept files of the archive exceed ${String(bytes - 1)} bytes`)
    await expect(read(withLicense([{ path: `${ROOT}/skills/big.md`, content: 'x'.repeat(4096) }]), 100))
      .rejects.toThrow('the kept files of the archive exceed 100 bytes')
  })

  it('refuses an archive without the license file', async () => {
    await expect(read(tarball([{ path: `${ROOT}/skills/alpha/SKILL.md`, content: 'x' }]))).rejects.toThrow('the archive holds no LICENSE')
  })

  it('refuses bytes that are not a tar archive', async () => {
    await expect(read(Buffer.from('not an archive, only text that is long enough to fill a header block'.repeat(10)))).rejects.toThrow()
  })
})

describe('digestFiles', () => {
  it('hashes each file as its path, its byte length, and its content, in path order', () => {
    const files = new Map([['skills/b.md', Buffer.from('é')], ['LICENSE', Buffer.from('x')]])
    const expected = createHash('sha256').update('LICENSE\x001\x00').update('x').update('skills/b.md\x002\x00').update('é').digest('hex')
    expect(digestFiles(files)).toBe(expected)
    expect(digestFiles(new Map([...files].toReversed()))).toBe(expected)
  })

  it('changes with a path or a content', () => {
    const digest = digestFiles(new Map([['LICENSE', Buffer.from('x')]]))
    expect(digestFiles(new Map([['LICENSE.md', Buffer.from('x')]]))).not.toBe(digest)
    expect(digestFiles(new Map([['LICENSE', Buffer.from('y')]]))).not.toBe(digest)
  })
})
