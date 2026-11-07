/**
 * Review layers of changed files. A repository's root `.gitattributes` decides first: its `dsh-review-layer`
 * attribute names a layer, and `linguist-generated` places a file in the `test` layer. The panel's `testPaths` and
 * `interfacePaths` configuration comes next, then the built-in rules, which follow the default file and directory
 * conventions of common languages and tools; every other file is in the `implementation` layer.
 */

import picomatch from 'picomatch'
import type { ParsedDiffFile } from './diff.ts'
import type { ForgeDiffFile, ForgeFileLayer } from './types.ts'
import { wildmatch } from './wildmatch.ts'

/** Path of the attributes file read beside each diff, relative to the repository root. */
export const ATTRIBUTES_PATH = '.gitattributes'

/** The attribute a repository sets to a layer name to place files in that layer. */
export const LAYER_ATTRIBUTE = 'dsh-review-layer'

/** The attribute GitHub Linguist reads to treat a file as generated. */
const GENERATED = 'linguist-generated'

const LAYERS: ReadonlySet<string> = new Set<ForgeFileLayer>(['interface', 'implementation', 'test'])

/** Whether an attribute value names a layer. */
function isLayer(value: string): value is ForgeFileLayer {
  return LAYERS.has(value)
}

/**
 * Tests, test data, snapshots, locale dictionaries, and lockfiles by the default conventions of their tools: test
 * directories, Jest and Vitest `*.spec.*` and `*.test.*` files, `go test` `*_test.go` files and `testdata/`
 * directories, pytest's `test_*.py`, `*_test.py`, and `conftest.py`, RSpec's `spec/` and `*_spec.rb`, SwiftPM's
 * `Tests/`, .NET `*.Tests/` projects, Jest and insta snapshots, i18next and Rails `locales/`, gettext catalogs,
 * Apple `.lproj` strings, Android string resources, and the lockfiles of npm, pnpm, Yarn, Bun, Cargo, Go modules,
 * Poetry, uv, Pipenv, Bundler, Composer, SwiftPM, NuGet, Gradle, pub, Mix, and Nix flakes.
 */
export const BUILT_IN_TEST_PATHS: readonly string[] = [
  '**/test/**', '**/tests/**', '**/Tests/**', '**/__tests__/**', '**/spec/**', '**/e2e/**', '**/testdata/**', '**/__mocks__/**',
  '**/__fixtures__/**', '**/*.Tests/**',
  '**/*.spec.*', '**/*.test.*', '**/*.e2e.*', '**/*_test.go', '**/test_*.py', '**/*_test.py', '**/conftest.py', '**/*_spec.rb',
  '**/__snapshots__/**', '**/*.snap',
  '**/locales/**', '**/*.po', '**/*.pot', '**/*.lproj/*.strings', '**/res/values-*/strings.xml',
  '**/package-lock.json', '**/npm-shrinkwrap.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lock', '**/bun.lockb', '**/Cargo.lock',
  '**/go.sum', '**/poetry.lock', '**/uv.lock', '**/Pipfile.lock', '**/Gemfile.lock', '**/composer.lock', '**/Package.resolved',
  '**/packages.lock.json', '**/gradle.lockfile', '**/pubspec.lock', '**/mix.lock', '**/flake.lock',
]

/**
 * Package manifests of npm, Go modules, Cargo, Python packaging, Bundler and RubyGems, Maven, Gradle, MSBuild,
 * SwiftPM, Composer, pub, and Mix; TypeScript declarations, Python stubs, and C and C++ headers; and interface
 * definitions of Protocol Buffers, GraphQL, Thrift, and OpenAPI.
 */
export const BUILT_IN_INTERFACE_PATHS: readonly string[] = [
  '**/package.json', '**/go.mod', '**/Cargo.toml', '**/pyproject.toml', '**/setup.py', '**/setup.cfg', '**/Gemfile', '**/*.gemspec',
  '**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/*.csproj', '**/Package.swift', '**/composer.json', '**/pubspec.yaml',
  '**/mix.exs',
  '**/*.d.ts', '**/*.d.mts', '**/*.d.cts', '**/*.pyi', '**/*.h', '**/*.hpp',
  '**/*.proto', '**/*.graphql', '**/*.graphqls', '**/*.thrift', '**/openapi.{json,yaml,yml}', '**/swagger.{json,yaml,yml}',
]

type Matcher = (path: string) => boolean

/** What a repository's attributes say about one path. */
interface PathAttributes {
  /** The layer `dsh-review-layer` names, or undefined while it is unspecified. */
  readonly layer: ForgeFileLayer | undefined
  /** Whether `linguist-generated` is set. */
  readonly generated: boolean
}

/**
 * Compile globs into one matcher; `*` matches dot files and never crosses `/`.
 * @param globs - picomatch globs.
 * @returns whether a repository-relative path matches any glob.
 */
function matcherOf(globs: readonly string[]): Matcher {
  return globs.length === 0 ? () => false : picomatch([...globs], { dot: true })
}

/**
 * Read the review attributes a `.gitattributes` text gives each path. Lines apply in order, so a later line overrides
 * an earlier one. `dsh-review-layer=<layer>` names `test`, `interface`, or `implementation`; another value,
 * `-dsh-review-layer`, and `!dsh-review-layer` leave the layer unspecified. `linguist-generated` and `=true` set
 * the generated attribute, `-linguist-generated` and `=false` unset it, and `!linguist-generated` returns it to
 * unspecified. Patterns follow Git's wildmatch rules, as {@link wildmatch} describes: a pattern without `/` matches a
 * file name at any depth, and one with `/` matches the path from the repository root. Macro definitions, quoted
 * patterns, negated patterns, which Git ignores in attributes, and patterns ending in `/`, which name directories and
 * so never match a file, are skipped.
 * @param attributes - the text of the root `.gitattributes`, empty without one.
 * @returns the attributes of a repository-relative path.
 */
export function attributesOf(attributes: string): (path: string) => PathAttributes {
  // `undefined` leaves an attribute as earlier lines set it, and `null` returns it to unspecified.
  const rules: {
    readonly match: Matcher
    readonly layer: ForgeFileLayer | null | undefined
    readonly generated: boolean | null | undefined
  }[] = []
  for (const raw of attributes.split(/\r?\n/)) {
    const [pattern, ...fields] = raw.trim().split(/\s+/)
    if (pattern === undefined || pattern === '' || pattern.startsWith('#') || pattern.startsWith('[attr]')
      || pattern.startsWith('"') || pattern.startsWith('!') || pattern.endsWith('/')) continue
    let layer: ForgeFileLayer | null | undefined
    let generated: boolean | null | undefined
    for (const field of fields) {
      if (field === GENERATED || field === `${GENERATED}=true`) generated = true
      else if (field === `-${GENERATED}` || field === `${GENERATED}=false`) generated = false
      else if (field === `!${GENERATED}`) generated = null
      else if (field.startsWith(`${LAYER_ATTRIBUTE}=`)) {
        const value = field.slice(LAYER_ATTRIBUTE.length + 1)
        layer = isLayer(value) ? value : null
      } else if (field === `-${LAYER_ATTRIBUTE}` || field === `!${LAYER_ATTRIBUTE}`) layer = null
    }
    const test = wildmatch(pattern.replace(/^\//, ''))
    if (test === undefined || (layer === undefined && generated === undefined)) continue
    const match: Matcher = pattern.includes('/') ? test : path => test(path.slice(path.lastIndexOf('/') + 1))
    rules.push({ match, layer, generated })
  }
  return (path) => {
    let layer: ForgeFileLayer | null | undefined
    let generated: boolean | null | undefined
    for (const rule of rules) {
      if (!rule.match(path)) continue
      if (rule.layer !== undefined) layer = rule.layer
      if (rule.generated !== undefined) generated = rule.generated
    }
    return { layer: layer ?? undefined, generated: generated === true }
  }
}

/** Classifies changed files into review layers by a repository's attributes, the panel's globs, and the built-in rules. */
export class FileLayers {
  private readonly rules: readonly { readonly layer: ForgeFileLayer; readonly match: Matcher }[]

  /**
   * @param testPaths - configured globs of the `test` layer, checked before the built-in rules.
   * @param interfacePaths - configured globs of the `interface` layer, checked after `testPaths` and before the built-in rules.
   */
  constructor(testPaths: readonly string[], interfacePaths: readonly string[]) {
    this.rules = [
      { layer: 'test', match: matcherOf(testPaths) },
      { layer: 'interface', match: matcherOf(interfacePaths) },
      { layer: 'test', match: matcherOf(BUILT_IN_TEST_PATHS) },
      { layer: 'interface', match: matcherOf(BUILT_IN_INTERFACE_PATHS) },
    ]
  }

  /**
   * Place each file in its layer: the layer its attributes name, else `test` for a generated file, else the first
   * configured or built-in rule its path matches, else `implementation`.
   * @param files - parsed files.
   * @param attributes - the text of the repository's root `.gitattributes`, empty without one.
   * @returns the files in the same order with their layers.
   */
  classify(files: readonly ParsedDiffFile[], attributes: string): ForgeDiffFile[] {
    const attributesAt = attributesOf(attributes)
    return files.map((file) => {
      const { layer, generated } = attributesAt(file.path)
      const ruled = layer ?? (generated ? 'test' : this.rules.find(rule => rule.match(file.path))?.layer) ?? 'implementation'
      return { ...file, layer: ruled }
    })
  }
}
