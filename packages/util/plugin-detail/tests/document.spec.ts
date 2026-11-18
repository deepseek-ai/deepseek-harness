/** Package document selection, language chains, and image destinations. */
import { expect, it } from 'vitest'
import { detailImage, languageChain, markdownOf, readPackageDocument } from '../src/document.ts'
import { DetailFailure, readmeName, type DetailFiles } from '../src/files.ts'

const signal = new AbortController().signal

/** Await a rejection that matches `fields` and whose message contains `message`. */
async function expectRejection(promise: Promise<unknown>, fields: object, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject(fields)
  await expect(promise).rejects.toThrow(message)
}

/** In-memory files. */
function memory(contents: Record<string, string>): DetailFiles & { reads: string[] } {
  const reads: string[] = []
  const read = (path: string, maxBytes: number) => {
    reads.push(path)
    const value = contents[path]
    if (value === undefined) return Promise.resolve(undefined)
    if (value.length > maxBytes) return Promise.reject(new DetailFailure('too-large', path))
    return Promise.resolve(new TextEncoder().encode(value))
  }
  return {
    key: 'memory', reads, read,
    async readme(dir, maxBytes) {
      const prefix = dir === '' ? '' : `${dir}/`
      const name = readmeName(Object.keys(contents).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length)))
      if (name === undefined) return undefined
      return { path: `${prefix}${name}`, bytes: (await read(`${prefix}${name}`, maxBytes)) as Uint8Array }
    },
  }
}

it('derives language chains from a language id', () => {
  expect(languageChain('zh-Hans-CN')).toEqual(['zh-hans-cn', 'zh-hans', 'zh', 'en'])
  expect(languageChain('en-US')).toEqual(['en-us', 'en'])
  expect(languageChain('en')).toEqual(['en'])
  expect(() => languageChain('../x')).toThrow('Not a language id')
})

it('decodes Markdown without a byte order mark or a leading front matter block', () => {
  expect(markdownOf(new TextEncoder().encode('\uFEFF---\ntitle: x\n---\n# A\n\n---\nkept: rule\n---\n'))).toBe('# A\n\n---\nkept: rule\n---\n')
  expect(markdownOf(new TextEncoder().encode('---\r\nk: v\r\n---'))).toBe('')
  expect(markdownOf(new TextEncoder().encode('# B'))).toBe('# B')
})

it('reads the locale document first, falling back through languages and failing on a missing named file', async () => {
  const files = memory({
    'locale/zh.json': JSON.stringify({ meta: { title: '无详情' } }),
    'locale/en.json': JSON.stringify({ meta: { detail: 'guide/DETAIL.md' } }),
    'locale/zh-CN.json': JSON.stringify({ meta: { detail: 'guide/详情.md' } }),
    'guide/DETAIL.md': '# Detail',
    'guide/详情.md': '# 详情',
    'README.md': '# Readme',
  })
  expect(await readPackageDocument(files, '', ['zh', 'en'], 100, signal)).toEqual({ origin: 'locale', path: 'guide/DETAIL.md', markdown: '# Detail' })
  expect(await readPackageDocument(files, '', languageChain('zh-CN'), 100, signal)).toMatchObject({ origin: 'locale', markdown: '# 详情' })
  expect(files.reads).toContain('locale/zh-cn.json')
  await readPackageDocument(files, '', languageChain('zh-Hant'), 100, signal)
  expect(files.reads).not.toContain('locale/zh-HANT.json')
  const missing = memory({ 'locale/en.json': JSON.stringify({ meta: { detail: 'GONE.md' } }) })
  await expectRejection(readPackageDocument(missing, '', ['en'], 100, signal), { reason: 'invalid' }, 'GONE.md')
})

it('reports malformed locale files and invalid detail paths, and falls back to the README without meta.detail', async () => {
  const read = (contents: Record<string, string>) => readPackageDocument(memory(contents), 'pkg', ['en'], 100, signal)
  await expectRejection(read({ 'pkg/locale/en.json': '{' }), { reason: 'invalid' }, 'pkg/locale/en.json')
  const invalid = [
    ['/README.md', 'must be a relative path inside the package'], ['../x.md', 'must be a relative path inside the package'],
    ['guide/./x.md', 'must be a relative path inside the package'], ['guide//x.md', 'must be a relative path inside the package'],
    ['guide\\x.md', 'must be a relative path inside the package'], ['https://example.com/x.md', 'must be a relative path inside the package'],
    ['README.txt', 'must name a Markdown file'], [' ', 'must be a non-empty string'], [7, 'must be a non-empty string'],
  ] as const
  for (const [detail, message] of invalid) {
    await expectRejection(read({ 'pkg/locale/en.json': JSON.stringify({ meta: { detail } }) }), { reason: 'invalid' }, `meta.detail ${message}`)
  }
  expect(await read({ 'pkg/locale/en.json': 'null', 'pkg/README': 'plain' })).toEqual({ origin: 'readme', path: 'pkg/README', markdown: 'plain' })
  expect(await read({ 'pkg/locale/en.json': '{"meta":"x"}' })).toBeUndefined()
  expect(await read({ 'pkg/locale/en.json': JSON.stringify({ meta: { detail: 'D.markdown' } }), 'pkg/D.markdown': '# D' }))
    .toMatchObject({ origin: 'locale', markdown: '# D' })
})

it('resolves image destinations beside a document and refuses other paths', () => {
  expect(detailImage('guide/DETAIL.md', 'img/a.png?raw=1#x')).toEqual({ path: 'guide/img/a.png', mediaType: 'image/png' })
  expect(detailImage('guide/DETAIL.md', '/logo.SVG')).toEqual({ path: 'logo.SVG', mediaType: 'image/svg+xml' })
  expect(detailImage('guide/DETAIL.md', './a%20b.webp')).toEqual({ path: 'guide/a b.webp', mediaType: 'image/webp' })
  expect(detailImage('README.md', 'b.jpeg')).toEqual({ path: 'b.jpeg', mediaType: 'image/jpeg' })
  for (const destination of ['../../etc/passwd.png', '..', '/', 'notes.txt', 'img\\a.png', '%E0%A4%A.png', 'a\0.png']) {
    expect(detailImage('guide/DETAIL.md', destination)).toBeUndefined()
  }
})
