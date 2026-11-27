/** The packaged SQL files and their loader. @module */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SQL_FILES, SqlFiles } from '../src/sql.ts'
import type { SqlFile } from '../src/sql.ts'

const root = fileURLToPath(new URL('../resources/sql', import.meta.url))
/** Every file under `resources/sql/`, as a path relative to it with forward slashes. */
const stored = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')).toSorted()

describe('SQL files', () => {
  it('declares exactly the files stored under resources/sql', () => {
    expect(SQL_FILES.map(name => `${name}.sql`).toSorted()).toEqual(stored)
    expect(new Set(SQL_FILES).size).toBe(SQL_FILES.length)
  })

  it.each(SQL_FILES)('%s starts with a comment, holds a statement, and ends with one newline', (name) => {
    const text = readFileSync(join(root, `${name}.sql`), 'utf8')
    expect(text.startsWith('-- ')).toBe(true)
    expect(text.split('\n').some(line => line !== '' && !line.trimStart().startsWith('--'))).toBe(true)
    expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true)
    expect(new SqlFiles().text(name)).toBe(text)
  })

  it('names the kebab-case statement files by folder', () => {
    const path = /^(schema\/v\d+|(upgrade\/\d+-to-\d+|store|derived|cold)\/[a-z0-9]+(-[a-z0-9]+)*)$/
    expect(SQL_FILES.filter(name => !path.test(name))).toEqual([])
  })

  it('reads a file once for each instance', () => {
    const files = new SqlFiles()
    const first = files.text('store/session-by-id')
    expect(files.text('store/session-by-id')).toBe(first)
    expect(first).toContain('FROM session_heads WHERE session_id = ?')
  })

  it('names the file it cannot read', () => {
    const absent = 'store/absent'
    let failure: unknown
    // The cast stands for a file the installed package lacks.
    try { new SqlFiles().text(absent as SqlFile) } catch (error: unknown) { failure = error }
    if (!(failure instanceof Error)) throw new Error('expected the read to fail', { cause: failure })
    expect(failure.message).toBe('SQL file "resources/sql/store/absent.sql" of the SQLite Session persistence package cannot be read')
    expect(failure.cause).toMatchObject({ code: 'ENOENT' })
  })
})
