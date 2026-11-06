/**
 * Review layers of changed files: the `testPaths` and `interfacePaths` globs of the panel's configuration, and the
 * `linguist-generated` attribute of a repository's root `.gitattributes`, which also places a file in the `test` layer.
 */

import picomatch from 'picomatch'
import type { ParsedDiffFile } from './diff.ts'
import type { ForgeDiffFile, ForgeFileLayer } from './types.ts'

/** Path of the attributes file read beside each diff, relative to the repository root. */
export const ATTRIBUTES_PATH = '.gitattributes'

/** The attribute GitHub Linguist reads to treat a file as generated. */
const GENERATED = 'linguist-generated'

type Matcher = (path: string) => boolean

/**
 * Compile globs into one matcher; `*` matches dot files and never crosses `/`.
 * @param globs - picomatch globs.
 * @returns whether a repository-relative path matches any glob.
 */
function matcherOf(globs: readonly string[]): Matcher {
  return globs.length === 0 ? () => false : picomatch([...globs], { dot: true })
}

/**
 * Read which paths a `.gitattributes` text marks `linguist-generated`. Lines apply in order, so a later line overrides
 * an earlier one; `linguist-generated` and `=true` set the attribute, `-linguist-generated` and `=false` unset it, and
 * `!linguist-generated` returns it to unspecified. A pattern without `/` matches a file name at any depth, and one with
 * `/` matches from the repository root. Macro definitions, quoted patterns, and patterns ending in `/`, which name
 * directories and so never match a file, are skipped.
 * @param attributes - the text of the root `.gitattributes`, empty without one.
 * @returns whether a repository-relative path is generated.
 */
export function generatedMatcher(attributes: string): Matcher {
  const rules: { readonly match: Matcher; readonly generated: boolean | undefined }[] = []
  for (const raw of attributes.split(/\r?\n/)) {
    const [pattern, ...fields] = raw.trim().split(/\s+/)
    if (pattern === undefined || pattern === '' || pattern.startsWith('#') || pattern.startsWith('[attr]')
      || pattern.startsWith('"') || pattern.endsWith('/')) continue
    let generated: boolean | null | undefined = null
    for (const field of fields) {
      if (field === GENERATED || field === `${GENERATED}=true`) generated = true
      else if (field === `-${GENERATED}` || field === `${GENERATED}=false`) generated = false
      else if (field === `!${GENERATED}`) generated = undefined
    }
    if (generated === null) continue
    const anchored = pattern.replace(/^\//, '')
    rules.push({ match: picomatch(anchored, { dot: true, basename: !pattern.includes('/') }), generated })
  }
  return (path) => {
    let generated: boolean | undefined
    for (const rule of rules) if (rule.match(path)) generated = rule.generated
    return generated === true
  }
}

/** Classifies changed files into review layers by the panel's path globs and a repository's attributes. */
export class FileLayers {
  private readonly test: Matcher
  private readonly interface: Matcher

  /**
   * @param testPaths - globs of the `test` layer.
   * @param interfacePaths - globs of the `interface` layer.
   */
  constructor(testPaths: readonly string[], interfacePaths: readonly string[]) {
    this.test = matcherOf(testPaths)
    this.interface = matcherOf(interfacePaths)
  }

  /**
   * Place each file in its layer: `test` first, then `interface`, else `implementation`.
   * @param files - parsed files.
   * @param attributes - the text of the repository's root `.gitattributes`, empty without one.
   * @returns the files in the same order with their layers.
   */
  classify(files: readonly ParsedDiffFile[], attributes: string): ForgeDiffFile[] {
    const generated = generatedMatcher(attributes)
    return files.map((file) => {
      const layer: ForgeFileLayer = this.test(file.path) || generated(file.path) ? 'test'
        : this.interface(file.path) ? 'interface' : 'implementation'
      return { ...file, layer }
    })
  }
}
