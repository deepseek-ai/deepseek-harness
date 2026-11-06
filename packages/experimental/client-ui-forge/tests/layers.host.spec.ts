/** Review layers of changed files: path globs and the `linguist-generated` attribute of a root `.gitattributes`. */
import { describe, expect, it } from 'vitest'
import { untrackedFile } from '../src/diff.ts'
import { FileLayers, generatedMatcher } from '../src/layers.ts'

describe('generatedMatcher', () => {
  it('applies lines in order, with unset and unspecified values overriding an earlier set', () => {
    const generated = generatedMatcher([
      '# comment',
      '',
      '[attr]binary -diff -merge -text',
      '"quoted name.json" linguist-generated',
      'build/ linguist-generated',
      '*.schema.json linguist-generated=true',
      'docs/kept.schema.json -linguist-generated',
      'docs/reset.schema.json !linguist-generated',
      'docs/off.schema.json linguist-generated=false',
      '/root.gen.ts linguist-generated',
      'gen/*.ts text linguist-generated',
      'other.txt text',
    ].join('\r\n'))

    expect(generated('a.schema.json')).toBe(true)
    expect(generated('docs/deep/a.schema.json')).toBe(true)
    expect(generated('docs/kept.schema.json')).toBe(false)
    expect(generated('docs/reset.schema.json')).toBe(false)
    expect(generated('docs/off.schema.json')).toBe(false)
    expect(generated('root.gen.ts')).toBe(true)
    expect(generated('nested/root.gen.ts')).toBe(false)
    expect(generated('gen/a.ts')).toBe(true)
    expect(generated('src/gen/a.ts')).toBe(false)
    expect(generated('build/out.js')).toBe(false)
    expect(generated('quoted name.json')).toBe(false)
    expect(generated('other.txt')).toBe(false)
  })

  it('marks nothing without attributes', () => {
    expect(generatedMatcher('')('a.ts')).toBe(false)
  })
})

describe('FileLayers', () => {
  const file = (path: string) => untrackedFile(path, new Uint8Array())

  it('places a file in the test layer first, then the interface layer, else the implementation layer', () => {
    const layers = new FileLayers(['**/*.spec.*', '**/locale/*.json'], ['**/package.json', '**/*.json'])
    const classified = layers.classify(
      ['src/a.ts', 'src/a.spec.ts', 'package.json', 'locale/en.json', 'docs/schema.json', '.github/x.json'].map(file),
      'docs/schema.json linguist-generated\n',
    )

    expect(classified.map(item => [item.path, item.layer])).toEqual([
      ['src/a.ts', 'implementation'],
      ['src/a.spec.ts', 'test'],
      ['package.json', 'interface'],
      ['locale/en.json', 'test'],
      ['docs/schema.json', 'test'],
      ['.github/x.json', 'interface'],
    ])
  })

  it('places every file in the implementation layer without globs or attributes', () => {
    expect(new FileLayers([], []).classify([file('a.spec.ts')], '')).toMatchObject([{ layer: 'implementation' }])
  })
})
