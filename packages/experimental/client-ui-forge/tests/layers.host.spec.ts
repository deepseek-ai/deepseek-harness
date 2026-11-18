/** Review layers of changed files: repository attributes, configured globs, and the built-in rules, in that order. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { untrackedFile } from '../src/diff.ts'
import { attributesOf, FileLayers } from '../src/layers.ts'

const run = promisify(execFile)
const file = (path: string) => untrackedFile(path, new Uint8Array())
const layersOf = (layers: FileLayers, paths: readonly string[], attributes = ''): string[] =>
  layers.classify(paths.map(file), attributes).map(item => `${item.path} ${item.layer}`)

describe('attributesOf', () => {
  const read = attributesOf([
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
    'api/*.yaml dsh-review-layer=interface',
    'api/legacy.yaml -dsh-review-layer',
    'api/odd.yaml dsh-review-layer=docs',
    'api/reset.yaml !dsh-review-layer',
    '*.snap.ts dsh-review-layer=test linguist-generated',
  ].join('\r\n'))

  it('applies lines in order, with unset and unspecified values overriding an earlier set', () => {
    const generated = (path: string): boolean => read(path).generated
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

  it('reads a layer name, and leaves an unset, reset, or unknown layer unspecified', () => {
    expect(read('api/v1.yaml')).toEqual({ layer: 'interface', generated: false })
    expect(read('api/legacy.yaml').layer).toBeUndefined()
    expect(read('api/odd.yaml').layer).toBeUndefined()
    expect(read('api/reset.yaml').layer).toBeUndefined()
    expect(read('src/a.snap.ts')).toEqual({ layer: 'test', generated: true })
  })

  it('marks nothing without attributes', () => {
    expect(attributesOf('')('a.ts')).toEqual({ layer: undefined, generated: false })
  })

  it('agrees with git check-attr on this repository\'s own review layer lines', async () => {
    const paths = [
      'packages/experimental/client-ui-forge/locale/en.json', 'packages/experimental/client-ui-forge/src/client/locales.ts',
      'packages/experimental/client-ui-forge/src/types.ts', 'packages/typert/generator/tests/fixtures/remote-model/packages/domain/src/types.ts',
      'packages/client/locale/package.json', 'snapshots/session/headless.snapshot.ts', 'README.i18n.yaml', 'docs/persistence-schema.json',
    ]
    const { stdout } = await run('git', ['check-attr', 'dsh-review-layer', 'linguist-generated', '--', ...paths])
    const expected = paths.map((path) => {
      const value = (name: string): string | undefined => new RegExp(`^${path.replaceAll('.', '\\.')}: ${name}: (.*)$`, 'm').exec(stdout)?.[1]
      const layer = value('dsh-review-layer')
      return { layer: layer === 'unspecified' ? undefined : layer, generated: value('linguist-generated') === 'true' }
    })
    const read = attributesOf(await readFile(new URL('../../../../.gitattributes', import.meta.url), 'utf8'))
    expect(paths.map(path => read(path))).toEqual(expected)
  })
})

describe('FileLayers', () => {
  it('follows the built-in conventions of common languages and tools', () => {
    expect(layersOf(new FileLayers([], []), [
      'pkg/server_test.go', 'pkg/testdata/in.txt', 'app/test_api.py', 'app/api_test.py', 'conftest.py', 'spec/models/user_spec.rb',
      'Tests/AppTests/AppTests.swift', 'App.Tests/UnitTest1.cs', 'src/a.spec.ts', 'src/__snapshots__/a.snap', 'config/locales/en.yml',
      'po/zh_CN.po', 'App/en.lproj/Localizable.strings', 'app/src/main/res/values-zh/strings.xml', 'Cargo.lock', 'go.sum', 'uv.lock',
      'go.mod', 'Cargo.toml', 'pyproject.toml', 'lib.gemspec', 'build.gradle.kts', 'App.csproj', 'Package.swift', 'include/api.h',
      'stubs/api.pyi', 'api/service.proto', 'schema.graphql', 'openapi.yaml', 'index.d.ts', 'package.json',
      'src/main.rs', 'docs/config-catalog.md', 'tsconfig.json', 'README.i18n.yaml',
    ])).toEqual([
      'pkg/server_test.go test', 'pkg/testdata/in.txt test', 'app/test_api.py test', 'app/api_test.py test', 'conftest.py test',
      'spec/models/user_spec.rb test', 'Tests/AppTests/AppTests.swift test', 'App.Tests/UnitTest1.cs test', 'src/a.spec.ts test',
      'src/__snapshots__/a.snap test', 'config/locales/en.yml test', 'po/zh_CN.po test', 'App/en.lproj/Localizable.strings test',
      'app/src/main/res/values-zh/strings.xml test', 'Cargo.lock test', 'go.sum test', 'uv.lock test',
      'go.mod interface', 'Cargo.toml interface', 'pyproject.toml interface', 'lib.gemspec interface', 'build.gradle.kts interface',
      'App.csproj interface', 'Package.swift interface', 'include/api.h interface', 'stubs/api.pyi interface', 'api/service.proto interface',
      'schema.graphql interface', 'openapi.yaml interface', 'index.d.ts interface', 'package.json interface',
      'src/main.rs implementation', 'docs/config-catalog.md implementation', 'tsconfig.json implementation', 'README.i18n.yaml implementation',
    ])
  })

  it('checks repository attributes, then configured globs, then the built-in rules', () => {
    const layers = new FileLayers(['**/fixtures/**'], ['**/cordis.yml', '**/*.spec.ts'])
    expect(layersOf(layers, [
      'src/a.spec.ts', 'tests/fixtures/cordis.yml', 'apps/cordis.yml', 'docs/schema.json', 'tests/keep.ts', 'src/api.ts', 'src/gen.ts',
    ], [
      'docs/schema.json linguist-generated',
      'tests/keep.ts dsh-review-layer=implementation',
      'src/api.ts dsh-review-layer=interface',
      'src/gen.ts linguist-generated dsh-review-layer=implementation',
    ].join('\n'))).toEqual([
      'src/a.spec.ts interface', 'tests/fixtures/cordis.yml test', 'apps/cordis.yml interface', 'docs/schema.json test',
      'tests/keep.ts implementation', 'src/api.ts interface', 'src/gen.ts implementation',
    ])
  })
})
