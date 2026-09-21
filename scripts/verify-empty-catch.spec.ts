import { readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createInventoryRepo, gitFixture as git, removeInventoryRepos, writeFixture as write } from './baseline-inventory.fixture.ts'
import { countEmptyCatches, findEmptyCatches, scanEmptyCatches, verifyEmptyCatch } from './verify-empty-catch.ts'

const baselinePath = 'scripts/empty-catch.baseline.json'
const sourcePath = 'packages/example/src/index.ts'
const seed = 'try { run() } catch (_failure) { /* seed */ }\n'
const broken = 'try { run() } catch {}\n'

afterEach(removeInventoryRepos)

function fixture(): string {
  return createInventoryRepo(baselinePath, seed)
}

function recordBaseline(root: string): string {
  const text = `${JSON.stringify(countEmptyCatches(scanEmptyCatches(root)), null, 2)}\n`
  write(root, baselinePath, text)
  return text
}

function defects(file: string, text: string): (readonly string[])[] {
  return findEmptyCatches(file, text).map(finding => finding.defects)
}

describe('empty catch syntax', () => {
  it.each([
    ['unbound and unexplained', 'try { run() } catch {}', ['unnamed', 'unexplained']],
    ['unbound with a reason', 'try { run() } catch { /* already gone */ }', ['unnamed']],
    ['bound without a reason', 'try { run() } catch (_missing) {}', ['unexplained']],
    ['bound to a bare underscore', 'try { run() } catch (_) { /* already gone */ }', ['unnamed']],
    ['reason between the keyword and the block', 'try { run() } catch /* already gone */ {}', ['unnamed']],
    ['comment above the statement', '// already gone\ntry { run() } catch {}', ['unnamed', 'unexplained']],
    ['multi-statement try', 'try { first(); second() } catch (_missing) { /* already gone */ }', ['wide-try']],
    ['a nested clause inside a handled clause', 'try { run() } catch (error) { try { log() } catch {} }', ['unnamed', 'unexplained']],
  ])('reports %s', (_name, text, expected) => {
    expect(defects('input.ts', text)).toEqual([expected])
  })

  it.each([
    ['a named and explained clause', 'try { run() } catch (_missing) { /* already gone */ }'],
    ['an ordinary binding name', 'try { run() } catch (error) { /* reported above */ }'],
    ['a finally block', 'try { run() } catch (_missing) { /* already gone */ } finally { stop() }'],
    ['a destructured binding', 'try { run() } catch ({ message }) { /* reported above */ }'],
    ['a handled clause around a conforming clause', 'try { run() } catch (error) { try { log() } catch (_inner) { /* reported */ } }'],
  ])('accepts %s', (_name, text) => {
    expect(findEmptyCatches('input.ts', text)).toEqual([])
  })

  it.each([
    ['a handled clause', 'try { run() } catch (error) { report(error) }'],
    ['a clause that rethrows', 'try { run() } catch (error) { throw error }'],
    ['a clause with a return', 'try { return run() } catch { return undefined }'],
    ['comment text inside a string', 'try { run() } catch (error) { report("// not a comment") }'],
  ])('ignores %s', (_name, text) => {
    expect(findEmptyCatches('input.ts', text)).toEqual([])
  })

  it('parses TSX so a JSX sibling does not hide the clause', () => {
    const text = 'export const view = <View onClick={() => { try { run() } catch {} }} />\n'
    expect(defects('input.tsx', text)).toEqual([['unnamed', 'unexplained']])
  })

  it('reports normalized paths and the catch keyword line', () => {
    const findings = findEmptyCatches('packages\\example\\index.ts', '\n\ntry { run() }\ncatch {}')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ file: 'packages/example/index.ts', line: 4 })
    expect(findings[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('keeps syntax fingerprints through whitespace and comment edits', () => {
    const original = findEmptyCatches('input.ts', 'try { run() } catch (_missing) {}')
    const formatted = findEmptyCatches('input.ts', '\ntry {\n  /* retried above */ run()\n}\ncatch (\n_missing\n) {\n}\n')
    expect(formatted.map(finding => finding.fingerprint)).toEqual(original.map(finding => finding.fingerprint))
    expect(findEmptyCatches('input.ts', 'try { run() } catch (_other) {}').map(finding => finding.fingerprint))
      .not.toEqual(original.map(finding => finding.fingerprint))
  })

  it('counts identical clauses per file', () => {
    expect(countEmptyCatches(findEmptyCatches('input.ts', `${broken}${broken}`))).toEqual({
      'input.ts': { [findEmptyCatches('input.ts', broken)[0]?.fingerprint ?? '']: 2 },
    })
  })
})

describe('empty catch inventory', () => {
  it('accepts a recorded clause after formatting without rewriting the baseline', () => {
    const root = fixture()
    write(root, sourcePath, broken)
    const baseline = recordBaseline(root)
    write(root, sourcePath, 'try { run() }\ncatch {\n}\n')
    expect(verifyEmptyCatch(root)).toBe(1)
    expect(verifyEmptyCatch(root, true)).toBe(1)
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe(baseline)
  })

  it.each([
    ['additional clause', `${broken}${broken}`],
    ['differently bound clause', 'try { stop() } catch (error) {}\n'],
    ['unexplained clause', 'try { run() } catch (_missing) {}\n'],
    ['wide try', 'try { first(); second() } catch (_missing) { /* reason */ }\n'],
  ])('rejects an %s without changing the baseline', (_name, text) => {
    const root = fixture()
    write(root, sourcePath, broken)
    const baseline = recordBaseline(root)
    write(root, sourcePath, text)
    expect(() => verifyEmptyCatch(root)).toThrow(/verify-empty-catch: an empty catch/u)
    expect(() => verifyEmptyCatch(root, true)).toThrow(/verify-empty-catch: an empty catch/u)
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe(baseline)
  })

  it('keeps a recorded clause inside its file allowance when an identical shape moves', () => {
    const root = fixture()
    write(root, sourcePath, broken)
    recordBaseline(root)
    write(root, sourcePath, 'try { stop() } catch {}\n')
    expect(verifyEmptyCatch(root)).toBe(1)
  })

  it('rejects a new clause when the inventory is empty', () => {
    const root = fixture()
    write(root, sourcePath, broken)
    expect(() => verifyEmptyCatch(root)).toThrow(`${sourcePath}:1 (unnamed, unexplained)`)
  })

  it('requires pruning retired counts while preserving the remaining clause', () => {
    const root = fixture()
    write(root, sourcePath, `${broken}${broken}`)
    write(root, 'apps/retired.ts', broken)
    recordBaseline(root)
    write(root, sourcePath, broken)
    unlinkSync(join(root, 'apps/retired.ts'))
    expect(() => verifyEmptyCatch(root)).toThrow(/remove retired baseline entries/u)
    expect(verifyEmptyCatch(root, true)).toBe(1)
    expect(JSON.parse(readFileSync(join(root, baselinePath), 'utf8'))).toEqual(
      countEmptyCatches(findEmptyCatches(sourcePath, broken)),
    )
    expect(verifyEmptyCatch(root)).toBe(1)
  })

  it('prunes a fixed clause and a deleted tracked file without treating them as discovery failures', () => {
    const root = fixture()
    write(root, sourcePath, broken)
    git(root, 'add', sourcePath)
    recordBaseline(root)
    write(root, sourcePath, seed)
    expect(() => verifyEmptyCatch(root)).toThrow(/remove retired baseline entries/u)
    expect(verifyEmptyCatch(root, true)).toBe(0)
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe('{}\n')
  })

  // The shared inventory reader owns the complete malformed-input table; these two rows prove this
  // gate reads through it rather than around it.
  it.each([
    ['not an object', '[]'],
    ['excluded path', '{"vendor/input.ts":{"HASH":1}}'],
  ])('rejects a malformed baseline: %s', (_name, text) => {
    const root = fixture()
    const contents = text.replaceAll('HASH', 'a'.repeat(64))
    write(root, baselinePath, contents)
    expect(() => verifyEmptyCatch(root, true)).toThrow()
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe(contents)
  })
})

describe('empty catch source discovery', () => {
  it('checks tracked source across areas, extensions and tests', () => {
    const root = fixture()
    const files = [
      'packages/example/src/input.ts',
      'apps/example/input.tsx',
      'scripts/input.mts',
      'website/input.cts',
      'packages/example/tests/input.js',
      'apps/example/input.jsx',
      'scripts/input.mjs',
      'website/input.cjs',
    ]
    for (const file of files) write(root, file, broken)
    git(root, 'add', '.')
    expect(scanEmptyCatches(root).map(finding => finding.file)).toEqual(files.toSorted())
    expect(() => verifyEmptyCatch(root)).toThrow(/verify-empty-catch: an empty catch/u)
  })

  it('includes untracked source while excluding ignored files, vendor, archives and other extensions', () => {
    const root = fixture()
    write(root, '.gitignore', 'ignored/\n')
    for (const file of ['ignored/input.ts', 'vendor/input.ts', '.agents/notes/archived/input.ts', 'docs/input.md']) {
      write(root, file, broken)
    }
    git(root, 'add', '.')
    write(root, 'scripts/new.ts', broken)
    expect(scanEmptyCatches(root).map(finding => finding.file)).toEqual(['scripts/new.ts'])
    expect(() => verifyEmptyCatch(root)).toThrow('scripts/new.ts:1')
    unlinkSync(join(root, 'scripts/new.ts'))
    expect(verifyEmptyCatch(root)).toBe(0)
  })

  it.each(['packages', 'apps', 'scripts', 'website'])('rejects discovery missing %s', (area) => {
    const root = fixture()
    unlinkSync(join(root, `${area}/seed.ts`))
    expect(() => verifyEmptyCatch(root)).toThrow(`source discovery omitted ${area}/`)
  })

  it('rejects a corpus without any catch clause', () => {
    const root = fixture()
    for (const area of ['packages', 'apps', 'scripts', 'website']) write(root, `${area}/seed.ts`, 'export {}\n')
    expect(() => verifyEmptyCatch(root)).toThrow(/found no catch clause/u)
  })

  // Creating file symlinks requires privileges that Windows CI does not guarantee.
  it.skipIf(process.platform === 'win32')('rejects a source symlink', () => {
    const root = fixture()
    write(root, 'target.txt', broken)
    const link = join(root, 'scripts/linked.ts')
    symlinkSync(join(root, 'target.txt'), link)
    try {
      expect(() => verifyEmptyCatch(root)).toThrow('source symlink is unsupported: scripts/linked.ts')
    } finally {
      unlinkSync(link)
    }
  })
})
