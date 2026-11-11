import { readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createInventoryRepo,
  gitFixture as git,
  removeInventoryRepos,
  writeFixture as write,
} from './baseline-inventory.fixture.ts'
import { countEmptyCatches, findEmptyCatches, scanEmptyCatches, verifyEmptyCatch } from './verify-empty-catch.ts'

const baselinePath = 'scripts/empty-catch.baseline.json'
const sourcePath = 'packages/example/src/index.ts'
const seed = 'try { run() } catch (_failure) { /* seed */ }\n'
const broken = 'try { run() } catch {}\n'
const recorded = 'try { run() } catch { /* reason */ }\n'

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
    ['comment above the whole statement', '// already gone\ntry { run() } catch {}', ['unnamed', 'unexplained']],
    ['comment inside the try block', 'try { run() /* already gone */ } catch {}', ['unnamed', 'unexplained']],
    ['multi-statement try', 'try { first(); second() } catch (_missing) { /* already gone */ }', ['wide-try']],
    ['a body of empty statements', 'try { run() } catch { ;;; }', ['unnamed', 'unexplained']],
    ['a pattern that binds nothing', 'try { run() } catch ({}) { /* already gone */ }', ['unnamed']],
    ['an array pattern that binds nothing', 'try { run() } catch ([]) { /* already gone */ }', ['unnamed']],
    ['a pattern binding only the discarded name', 'try { run() } catch ({ _ }) { /* already gone */ }', ['unnamed']],
    ['a nested clause inside a handled clause', 'try { run() } catch (error) { try { log() } catch {} }', ['unnamed', 'unexplained']],
    ['a comment marker inside a trailing string', 'try { run() } catch (_missing) {} finally { log("// not a comment") }', ['unexplained']],
    ['a comment marker inside a trailing regular expression', 'try { run() } catch (_missing) {} finally { match(/[/*]/) }', ['unexplained']],
    ['a comment trailing a finally block', 'try { run() } catch (_missing) {} finally { stop() } // Reported above.', ['unexplained']],
    ['a comment after another statement on the closing line', 'try { run() } catch (_missing) {}; stop() // Stopped.', ['unexplained']],
    ['a comment on the line after the clause', 'try { run() } catch (_missing) {}\n// Stopped.\nstop()', ['unexplained']],
    ['a comment on the line after the clause with CRLF', 'try { run() } catch (_missing) {}\r\n// Stopped.\r\nstop()', ['unexplained']],
    ['a comment marker inside a binding default regular expression', 'try { run() } catch ({ message = /[/*]/ }) {}', ['unexplained']],
    ['a comment marker inside a binding default template', 'try { run() } catch ({ message = `${prefix}//` }) {}', ['unexplained']],
  ])('reports %s', (_name, text, expected) => {
    expect(defects('input.ts', text)).toEqual([expected])
  })

  it.each([
    ['a named and explained clause', 'try { run() } catch (_missing) { /* already gone */ }'],
    ['an ordinary binding name', 'try { run() } catch (error) { /* reported above */ }'],
    ['a reason on the line above the clause', 'try { run() }\n// The session may already be gone.\ncatch (_missing) {}'],
    ['a reason on the line closing the clause', 'try { run() } catch (_missing) {} // The session may already be gone.'],
    ['a reason on the line closing the clause with CRLF', 'try { run() } catch (_missing) {} // Already gone.\r\nstop()'],
    ['a block comment above the clause', 'try { run() }\n/* The session may already be gone. */\ncatch (_missing) {}'],
    ['a reason between the clause and a finally block', 'try { run() } catch (_missing) {} /* Reported above. */ finally { stop() }'],
    // One block or compound statement counts as one statement, however much it holds.
    ['a try holding one block', 'try { { first(); second() } } catch (_missing) { /* already gone */ }'],
    ['a try holding one if statement', 'try { if (ready) { first(); second() } } catch (_missing) { /* already gone */ }'],
    ['a finally block', 'try { run() } catch (_missing) { /* already gone */ } finally { stop() }'],
    ['empty statements beside the try statement', 'try { ; run() } catch (_missing) { /* already gone */ }'],
    ['a destructured binding', 'try { run() } catch ({ message }) { /* reported above */ }'],
    ['a handled clause around a conforming clause', 'try { run() } catch (error) { try { log() } catch (_inner) { /* reported */ } }'],
  ])('accepts %s', (_name, text) => {
    expect(findEmptyCatches('input.ts', text)).toEqual([])
  })

  // A no-op body other than `;` is out of scope, so the gate must not claim it.
  it.each([
    ['a handled clause', 'try { run() } catch (error) { report(error) }'],
    ['a clause that rethrows', 'try { run() } catch (error) { throw error }'],
    ['a clause with a return', 'try { return run() } catch { return undefined }'],
    ['a directive body', 'try { run() } catch { "use strict" }'],
    ['a void expression body', 'try { run() } catch { void 0 }'],
    ['a block expression body', 'try { run() } catch { {} }'],
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

  it('changes the fingerprint when a clause gains a defect', () => {
    const [recorded] = findEmptyCatches('input.ts', 'try { run() } catch { /* already gone */ }')
    const [widened] = findEmptyCatches('input.ts', 'try { first(); second() } catch { /* already gone */ }')
    const [unexplained] = findEmptyCatches('input.ts', 'try { run() } catch {}')
    expect(widened?.fingerprint).not.toBe(recorded?.fingerprint)
    expect(unexplained?.fingerprint).not.toBe(recorded?.fingerprint)
    expect(findEmptyCatches('input.ts', 'try { stop() } catch { /* already gone */ }')[0]?.fingerprint)
      .toBe(recorded?.fingerprint)
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
    ['another copy of a recorded clause', `${recorded}${recorded}`],
    ['a differently bound clause', 'try { stop() } catch (error) {}\n'],
    ['an unexplained clause', 'try { run() } catch (_missing) {}\n'],
    ['a wide try', 'try { first(); second() } catch (_missing) { /* reason */ }\n'],
    ['a recorded clause with a widened try', 'try { first(); second() } catch { /* reason */ }\n'],
    ['a recorded clause without its reason', 'try { run() } catch {}\n'],
  ])('rejects %s without changing the baseline', (_name, text) => {
    const root = fixture()
    write(root, sourcePath, recorded)
    const baseline = recordBaseline(root)
    write(root, sourcePath, text)
    expect(() => verifyEmptyCatch(root)).toThrow(/verify-empty-catch: an empty catch/u)
    expect(() => verifyEmptyCatch(root, true)).toThrow(/verify-empty-catch: an empty catch/u)
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe(baseline)
  })

  it('keeps a recorded clause inside its file allowance when only its try statement changes', () => {
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

  it('points a rejection at the repository guidance for discarding an error', () => {
    const root = fixture()
    write(root, sourcePath, broken)
    const skillPath = '.agents/skills/dsh-error-handling/SKILL.md'
    expect(() => verifyEmptyCatch(root)).toThrow(`(see ${skillPath}#empty-catch-clauses)`)
    expect(readFileSync(join(import.meta.dirname, '..', skillPath), 'utf8')).toMatch(/^### Empty catch clauses$/mu)
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
  it('checks tracked source across areas, extensions, tests and root configuration', () => {
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
      'config.ts',
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
