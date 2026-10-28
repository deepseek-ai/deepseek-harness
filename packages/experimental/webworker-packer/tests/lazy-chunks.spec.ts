/**
 * Page chunks reached only through `require.async("./client.<name>.js")` leave
 * the base image: each one becomes its own deterministic, content-addressed
 * archive, and the manifest registers its path and size for the Worker's lazy
 * filesystem. Entries, eagerly loaded `./client` targets, and unreferenced
 * siblings stay in the base image.
 */
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { parseTar } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/tar.ts'
import { MANIFEST_PATH, packVfsImage, type PackOptions } from '../src/pack.ts'

const SUBJECT = '@deepseek-ai/dsh-lazy-chunk-fixture'
const PREFIX = `node_modules/${SUBJECT}/lib`

function fixture(test: TestContext, files: Record<string, string>): PackOptions {
  const root = mkdtempSync(join(tmpdir(), 'dsh-image-lazy-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: SUBJECT,
    type: 'module',
    files: ['lib'],
    exports: { '.': './lib/index.js', './client': './lib/client.browser.js' },
  }))
  writeFileSync(join(root, 'lib/index.js'), 'export const value = 1')
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'lib', name), body)
  return {
    profile: 'lazy-check',
    roster: [SUBJECT],
    workspaces: new Map([[SUBJECT, root]]),
    resolveFrom: root,
    entries: [],
  }
}

const CHUNKS = {
  'client.browser.js': 'module.exports = { load: () => require.async("./client.pdf.js") }',
  'client.pdf.js': 'module.exports = { worker: () => require.async(\'./client.pdf-worker.js\') }',
  'client.pdf-worker.js': 'module.exports = "pdf worker"',
  'client.orphan.js': 'module.exports = "nobody asks for me"',
}

it('moves every require.async chunk into its own archive and registers it', (test) => {
  const result = packVfsImage(fixture(test, CHUNKS))
  const base = Object.keys(result.files)
  expect(base).toContain(`${PREFIX}/client.browser.js`)
  expect(base).toContain(`${PREFIX}/client.orphan.js`)
  expect(base).not.toContain(`${PREFIX}/client.pdf.js`)
  expect(base).not.toContain(`${PREFIX}/client.pdf-worker.js`)

  expect(result.lazyArchives.map(archive => archive.files)).toEqual([
    [`${PREFIX}/client.pdf-worker.js`],
    [`${PREFIX}/client.pdf.js`],
  ])
  const manifest = JSON.parse(new TextDecoder().decode(result.files[MANIFEST_PATH])) as {
    lazy: Array<{ archive: string; files: Array<{ path: string; size: number }> }>
  }
  for (const [index, archive] of result.lazyArchives.entries()) {
    const digest = createHash('sha256').update(archive.image).digest('hex')
    expect(archive.name).toBe(`lazy/${digest}.tar.gz`)
    const entries = parseTar(gunzipSync(archive.image))
    expect(entries.map(entry => entry.name)).toEqual(archive.files)
    // The archived bytes are the debugger-named page bundle the base image would have carried.
    expect(new TextDecoder().decode(entries[0]!.bytes)).toMatch(/\n\/\/# sourceURL=\S+$/)
    expect(manifest.lazy[index]).toEqual({
      archive: archive.name,
      files: [{ path: entries[0]!.name, size: entries[0]!.bytes.length }],
    })
  }
})

it('packs the same chunks to the same archive names and bytes', (test) => {
  const first = packVfsImage(fixture(test, CHUNKS))
  const second = packVfsImage(fixture(test, CHUNKS))
  expect(second.lazyArchives.map(archive => archive.name)).toEqual(first.lazyArchives.map(archive => archive.name))
  expect(Buffer.from(second.image).equals(Buffer.from(first.image))).toBe(true)
})

it('refuses a chunk request whose file the package does not publish', (test) => {
  const options = fixture(test, { 'client.browser.js': 'module.exports = () => require.async("./client.missing.js")' })
  expect(() => packVfsImage(options)).toThrow(/client\.browser\.js requests chunk "\.\/client\.missing\.js"/)
})

it('keeps a ./client export target in the base image even when a chunk requests it', (test) => {
  const result = packVfsImage(fixture(test, {
    'client.browser.js': 'module.exports = { load: () => require.async("./client.pdf.js") }',
    'client.pdf.js': 'module.exports = { back: () => require.async("./client.browser.js") }',
  }))
  expect(Object.keys(result.files)).toContain(`${PREFIX}/client.browser.js`)
  expect(result.lazyArchives.map(archive => archive.files)).toEqual([[`${PREFIX}/client.pdf.js`]])
})
