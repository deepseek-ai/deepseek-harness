/**
 * Cordis-free tests for the line-windowing module: offset/limit windows, byte
 * caps, per-line truncation, CRLF stripping, offset-past-EOF rejection, and the
 * capped line buffer for newline-free giant lines — all over an async-iterable
 * of decoded text chunks (so one code path serves whole-file and streamed reads).
 */

import { describe, expect, it } from 'vitest'
import { languageForPath } from '@deepseek-ai/dsh-util-code-language'
import { buildWindow, langFromPath, readMetaFromMeta, READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from '../src/read-render.ts'
import type { ReadWindow } from '../src/read-render.ts'

const DEFAULT_CAPS = { maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES }
const READ_ALL: ReadWindow = { offset: 1, limit: 2000, ...DEFAULT_CAPS }

/** Yield `text` as one chunk (whole-file read shape). */
async function* whole(text: string): AsyncIterable<string> {
  yield text
}

/** Yield `text` split into fixed-size chunks (streamed read shape). */
async function* chunked(text: string, size: number): AsyncIterable<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
}

describe('buildWindow', () => {
  it('numbers lines and reports total for a whole-file read', async () => {
    const result = await buildWindow(whole('one\ntwo\nthree'), READ_ALL, 'f')
    expect(result.lines).toEqual([
      { number: 1, text: 'one' },
      { number: 2, text: 'two' },
      { number: 3, text: 'three' },
    ])
    expect(result.totalLines).toBe(3)
    expect(result.truncatedByBytes).toBe(false)
  })

  it('applies offset/limit', async () => {
    const result = await buildWindow(whole('one\ntwo\nthree\nfour'), { offset: 2, limit: 2, ...DEFAULT_CAPS }, 'f')
    expect(result.lines.map(l => l.number)).toEqual([2, 3])
    expect(result.totalLines).toBe(4)
  })

  it('strips CRLF', async () => {
    const result = await buildWindow(whole('one\r\ntwo\r\n'), READ_ALL, 'f')
    expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
  })

  it('truncates an over-long line', async () => {
    const result = await buildWindow(whole('x'.repeat(3000)), READ_ALL, 'f')
    expect(result.lines[0]?.text).toContain(`... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`)
  })

  it('caps output bytes and reports truncatedByBytes', async () => {
    const big = Array.from({ length: 2000 }, () => 'y'.repeat(100)).join('\n')
    const result = await buildWindow(whole(big), READ_ALL, 'f')
    expect(result.truncatedByBytes).toBe(true)
  })

  it('reads an empty file at offset 1 as zero lines', async () => {
    const result = await buildWindow(whole(''), READ_ALL, 'f')
    expect(result.lines).toEqual([])
    expect(result.totalLines).toBe(0)
  })

  it('rejects an offset past EOF', async () => {
    await expect(buildWindow(whole('one\ntwo'), { offset: 9, limit: 1, ...DEFAULT_CAPS }, 'f')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('flushes a final line with no trailing newline', async () => {
    const result = await buildWindow(whole('one\ntwo'), READ_ALL, 'f')
    expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
  })

  it('handles a trailing newline (no dangling empty line)', async () => {
    const result = await buildWindow(whole('one\ntwo\n'), READ_ALL, 'f')
    expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
    expect(result.totalLines).toBe(2)
  })

  describe('caps are per-request (the plugin config reaches the window)', () => {
    it('truncates lines at a custom maxLineLength and names it in the suffix', async () => {
      const result = await buildWindow(whole('abcdefghij'), { offset: 1, limit: 10, maxLineLength: 5, maxBytes: READ_MAX_BYTES }, 'f')
      expect(result.lines[0]?.text).toBe('abcde... (line truncated to 5 chars)')
    })

    it('caps output at a custom maxBytes', async () => {
      const result = await buildWindow(whole('aaaa\nbbbb\ncccc'), { offset: 1, limit: 10, maxLineLength: 2000, maxBytes: 9 }, 'f')
      expect(result.lines.map(l => l.text)).toEqual(['aaaa', 'bbbb'])
      expect(result.totalLines).toBe(3)
      expect(result.truncatedByBytes).toBe(true)
    })
  })

  describe('chunked input (streamed read shape)', () => {
    it('windows identically when text arrives in small chunks', async () => {
      const result = await buildWindow(chunked('one\ntwo\nthree', 2), { offset: 2, limit: 1, ...DEFAULT_CAPS }, 'f')
      expect(result.lines).toEqual([{ number: 2, text: 'two' }])
      expect(result.totalLines).toBe(3)
    })

    it('caps a newline-free giant line split across chunks without unbounded buffering', async () => {
      const result = await buildWindow(chunked('z'.repeat(5000), 256), READ_ALL, 'f')
      expect(result.lines[0]?.text).toContain(`... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`)
    })

    it('caps output bytes mid-stream', async () => {
      const big = Array.from({ length: 2000 }, () => 'y'.repeat(100)).join('\n')
      const result = await buildWindow(chunked(big, 512), READ_ALL, 'f')
      expect(result.totalLines).toBe(2000)
      expect(result.truncatedByBytes).toBe(true)
    })

    it('flushes a final newline-terminated line across a chunk boundary', async () => {
      const result = await buildWindow(chunked('one\ntwo\n', 3), READ_ALL, 'f')
      expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
    })
  })
})

/**
 * The short `lang` values a recorded read persisted, transcribed verbatim.
 * Changing any value changes replay-visible output for an already-recorded
 * session, so this table is the test's independent expectation rather than a
 * second read of the implementation's own data.
 */
const PERSISTED_READ_LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  cs: 'cs', kt: 'kotlin', swift: 'swift', php: 'php',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'md', markdown: 'md', mdx: 'mdx',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', lua: 'lua',
}

describe('langFromPath', () => {
  it('keeps every already-persisted suffix byte-identical', () => {
    expect(Object.keys(PERSISTED_READ_LANG_BY_EXTENSION)).toHaveLength(43)
    for (const [extension, hint] of Object.entries(PERSISTED_READ_LANG_BY_EXTENSION)) {
      expect(langFromPath(`file.${extension}`), extension).toBe(hint)
    }
  })

  it('gives every other suffix the language short id', () => {
    // A suffix with no persisted value has none to preserve, so the projection
    // applies the language's short name instead of the canonical grammar id.
    expect(langFromPath('build.ps1')).toBe('ps1')
    expect(langFromPath('table.csv')).toBe('csv')
    expect(langFromPath('deploy.bat')).toBe('bat')
    expect(langFromPath('.env')).toBe('env')
    expect(langFromPath('server.log')).toBe('log')
    expect(langFromPath('message.proto')).toBe('proto')
    expect(langFromPath('infra.tf')).toBe('tf')
    expect(langFromPath('paper.tex')).toBe('tex')
    expect(langFromPath('model.jl')).toBe('jl')
    expect(langFromPath('top.v')).toBe('v')
    expect(langFromPath('build.gradle')).toBe('gradle')
    // A later suffix of an already-known language follows that language's short name.
    expect(langFromPath('app.conf')).toBe('ini')
    expect(langFromPath('task.rake')).toBe('rb')
    expect(langFromPath('events.jsonl')).toBe('json')
    expect(langFromPath('page.xhtml')).toBe('html')
    expect(langFromPath('logo.svg')).toBe('xml')
    expect(langFromPath('notebook.ipynb')).toBe('json')
  })

  it('maps a known extension to its persisted short hint, case-insensitively', () => {
    expect(langFromPath('src/a.ts')).toBe('ts')
    expect(langFromPath('src/a.TSX')).toBe('tsx')
    expect(langFromPath('/abs/module.mjs')).toBe('js')
    expect(langFromPath('conf.yml')).toBe('yaml')
    expect(langFromPath('README.md')).toBe('md')
  })

  it('keeps the canonical ids the Client code surfaces use out of the persisted hint', () => {
    // The Client reads the shared table directly; only this projection owns the
    // persisted value, so the two intentionally differ for the suffixes a
    // recorded session already holds.
    expect(languageForPath('src/a.ts')).toBe('typescript')
    expect(languageForPath('README.md')).toBe('markdown')
    expect(langFromPath('src/a.ts')).not.toBe(languageForPath('src/a.ts'))
  })

  it('reads the extension after the last path segment and last dot', () => {
    expect(langFromPath('a.py.bak')).toBeUndefined()
    expect(langFromPath('archive.tar.gz')).toBeUndefined()
    expect(langFromPath('/dir.py/plain')).toBeUndefined()
    expect(langFromPath('C:\\src\\main.rs')).toBe('rs')
  })

  it('returns undefined for a dotfile, an extensionless name, and an unknown extension', () => {
    expect(langFromPath('.gitignore')).toBeUndefined()
    expect(langFromPath('/etc/hosts')).toBeUndefined()
    expect(langFromPath('data.unknownext')).toBeUndefined()
    expect(langFromPath('trailingdot.')).toBeUndefined()
  })

  it('returns undefined for a filename whose extension is an Object.prototype key', () => {
    // Own-property lookup only: these must not resolve to the inherited member
    // (a function/object), which would fail the tool-output JSON validation.
    expect(langFromPath('foo.constructor')).toBeUndefined()
    expect(langFromPath('foo.__proto__')).toBeUndefined()
    expect(langFromPath('foo.toString')).toBeUndefined()
    expect(langFromPath('foo.hasOwnProperty')).toBeUndefined()
  })
})

describe('readMetaFromMeta', () => {
  const good = { path: '/abs/a.ts', offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 1, lang: 'ts' }

  it('narrows a well-formed read meta, with and without a lang hint', () => {
    expect(readMetaFromMeta(good)).toEqual(good)
    const noLang = { path: '/abs/a', offset: 1, lines: [], totalLines: 0 }
    expect(readMetaFromMeta(noLang)).toEqual(noLang)
  })

  it('narrows an empty window at a positive offset (byte cap below the first selected line)', () => {
    const empty = { path: '/abs/a', offset: 5, lines: [], totalLines: 9 }
    expect(readMetaFromMeta(empty)).toEqual(empty)
  })

  it('returns undefined for absent, non-object, or array meta', () => {
    expect(readMetaFromMeta(undefined)).toBeUndefined()
    expect(readMetaFromMeta(null)).toBeUndefined()
    expect(readMetaFromMeta('nope')).toBeUndefined()
    expect(readMetaFromMeta([good])).toBeUndefined()
  })

  it('returns undefined when a field is missing or the wrong type (defensive narrowing)', () => {
    expect(readMetaFromMeta({ ...good, path: 5 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, offset: '1' })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, totalLines: '1' })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: 'nope' })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [{ number: '1', text: 'x' }] })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [{ number: 1 }] })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [null] })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lang: 5 })).toBeUndefined()
  })

  it('rejects an offset that is not a 1-based integer', () => {
    expect(readMetaFromMeta({ ...good, offset: 0 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, offset: 1.5 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, offset: NaN })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, offset: Infinity })).toBeUndefined()
  })

  it('rejects a first line number below offset', () => {
    expect(readMetaFromMeta({ ...good, offset: 2, lines: [{ number: 1, text: 'x' }], totalLines: 2 })).toBeUndefined()
  })

  it('rejects a line number that is not a 1-based integer', () => {
    expect(readMetaFromMeta({ ...good, lines: [{ number: 0, text: 'x' }], totalLines: 1 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [{ number: 1.5, text: 'x' }], totalLines: 2 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [{ number: NaN, text: 'x' }], totalLines: 1 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, lines: [{ number: Infinity, text: 'x' }], totalLines: 1 })).toBeUndefined()
  })

  it('rejects a totalLines that is not a non-negative integer', () => {
    expect(readMetaFromMeta({ ...good, totalLines: -1 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, totalLines: 1.5 })).toBeUndefined()
    expect(readMetaFromMeta({ ...good, totalLines: NaN })).toBeUndefined()
  })

  it('rejects lines that do not strictly increase or exceed totalLines', () => {
    const twoLines = { path: '/abs/a', offset: 1, lang: 'ts' }
    // Duplicate line numbers.
    expect(readMetaFromMeta({ ...twoLines, lines: [{ number: 1, text: 'a' }, { number: 1, text: 'b' }], totalLines: 2 })).toBeUndefined()
    // Out-of-order line numbers.
    expect(readMetaFromMeta({ ...twoLines, lines: [{ number: 2, text: 'b' }, { number: 1, text: 'a' }], totalLines: 2 })).toBeUndefined()
    // A line number past totalLines.
    expect(readMetaFromMeta({ ...twoLines, lines: [{ number: 3, text: 'c' }], totalLines: 2 })).toBeUndefined()
  })
})
