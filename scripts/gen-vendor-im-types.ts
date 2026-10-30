/**
 * Reproduce the retained Feishu API declarations from integrity-checked upstream source.
 *
 * The rendered subset is committed under `vendor/plugin-im-adapter-lark/src/types/`, so installing the repository
 * never needs the network: `--check` verifies the committed files against the digests recorded at generation time,
 * and re-renders them only when the pinned sources are already cached. `pnpm run gen:vendor-im` downloads the
 * pinned sources when the cache is cold, regenerates the subset, and records the new output digests.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import upstream from './vendor-im/upstream.json' with { type: 'json' }

const files = ['index.ts', 'auth.ts', 'im.ts', 'contact.ts'] as const
type SourceFile = typeof files[number]
/** Fixed upstream inputs consumed by the subset generator. */
export type LarkSources = Record<SourceFile, string>

/** The reviewed upstream pin: the source revision, its input digests and the digests of the committed output. */
interface VendorPin {
  commit: string
  files: Record<SourceFile, string>
  rendered?: Record<SourceFile, string>
}

const pin = upstream as VendorPin

/** First line of every generated file, naming the upstream revision the subset was rendered from. */
function headerOf(commit: string): string {
  return `/** Generated from satori@${commit} by scripts/gen-vendor-im-types.ts; do not edit. */\n`
}

/** SHA-256 of one file's text, as recorded in the pin. */
function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Check downloaded or cached source before it can enter the build.
 * @param source - UTF-8 upstream file contents.
 * @param digest - Expected SHA-256 from the reviewed pin.
 * @param name - File name for a failed integrity check.
 */
export function verifyLarkSource(source: string, digest: string, name: string): void {
  if (createHash('sha256').update(source).digest('hex') !== digest) {
    throw new Error(`Feishu codegen integrity mismatch: ${name}; remove its cache entry and retry, or review a new upstream pin`)
  }
}

/**
 * Retain the generated API families and the shared declaration closure they use.
 * @param sources - Pinned, verified upstream files.
 * @param consumers - Handwritten adapter sources whose shared types must remain exported.
 * @param commit - Upstream revision named in the generated header (defaults to the pin).
 * @returns Reproducible source files with scoped ESM-compatible imports.
 */
export function renderLarkTypes(
  sources: LarkSources, consumers: readonly string[], commit: string = pin.commit,
): LarkSources {
  const parse = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
  const shared = parse('index.ts', sources['index.ts'])
  const declarations = new Map<string, ts.Statement>()
  for (const statement of shared.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      declarations.set(statement.name.text, statement)
    }
  }
  const referenced = new Set<string>()
  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) referenced.add(node.text)
    ts.forEachChild(node, collect)
  }
  for (const name of files.slice(1)) collect(parse(name, sources[name]))
  for (const consumer of consumers) collect(parse('consumer.ts', consumer))
  const retained = new Set<string>()
  for (const name of referenced) {
    const declaration = declarations.get(name)
    if (!declaration || retained.has(name)) continue
    retained.add(name)
    collect(declaration)
  }
  const header = headerOf(commit)
  const result: LarkSources = { ...sources }
  result['index.ts'] = header + files.slice(1).map(name => `export * from './${name}'`).join('\n')
    + '\n' + [...declarations].filter(([name]) => retained.has(name))
    .map(([, declaration]) => declaration.getFullText(shared)).join('').trimEnd() + '\n'
  for (const name of files.slice(1)) {
    const tree = parse(name, sources[name])
    const edits: { start: number; end: number; text: string }[] = []
    for (const statement of tree.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text
        edits.push({ start: statement.moduleSpecifier.getStart(tree), end: statement.moduleSpecifier.end,
          text: `'${specifier === '.' ? './index.ts' : specifier + '.ts'}'` })
        const clause = statement.importClause
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          edits.push({ start: clause.getStart(tree), end: clause.getStart(tree), text: 'type ' })
        } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            if (element.name.text === 'Internal') continue
            edits.push({ start: element.getStart(tree), end: element.getStart(tree), text: 'type ' })
          }
        }
      } else if (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name)) {
        edits.push({ start: statement.name.getStart(tree), end: statement.name.end, text: `'${statement.name.text}.ts'` })
      }
    }
    let text = sources[name]
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
    result[name] = header + text
  }
  return result
}

/**
 * Verify the committed subset against the digests recorded when it was generated, without network access.
 * @param directory - directory holding the committed generated files.
 * @param recorded - output digests from the pin; absent before the first recorded generation.
 * @throws Error when a file is missing, edited, or names another upstream revision.
 */
async function verifyCommitted(directory: string, recorded: Record<SourceFile, string> | undefined): Promise<void> {
  if (recorded === undefined) {
    throw new Error('Feishu codegen output has no recorded digests; run pnpm run gen:vendor-im')
  }
  for (const name of files) {
    const target = resolve(directory, name)
    let current: string
    try { current = await readFile(target, 'utf8') } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      throw new Error(`Feishu codegen output is missing: ${target}; run pnpm run gen:vendor-im`)
    }
    if (digestOf(current) !== recorded[name]) {
      throw new Error(`Feishu codegen output is stale: ${target}; run pnpm run gen:vendor-im`)
    }
    if (!current.startsWith(headerOf(pin.commit))) {
      throw new Error(`Feishu codegen output names another upstream revision: ${target}; run pnpm run gen:vendor-im`)
    }
  }
}

/**
 * Load the pinned upstream sources from the cache, or download the ones the cache does not hold.
 * @param cache - cache directory of the pinned commit.
 * @param download - false to accept only already-cached sources, leaving the network untouched.
 * @returns the four verified sources, or undefined when the cache is cold and `download` is false.
 */
async function loadSources(cache: string, download: boolean): Promise<LarkSources | undefined> {
  const sources: LarkSources = { 'index.ts': '', 'auth.ts': '', 'im.ts': '', 'contact.ts': '' }
  for (const name of files) {
    let text: string
    try {
      text = await readFile(resolve(cache, name), 'utf8')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      if (!download) return undefined
      const url = `https://raw.githubusercontent.com/satorijs/satori/${pin.commit}/adapters/lark/src/types/${name}`
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`Feishu codegen download failed: ${name}, HTTP ${response.status}`)
      text = await response.text()
      verifyLarkSource(text, pin.files[name], name)
      await writeAtomic(resolve(cache, name), text)
    }
    verifyLarkSource(text, pin.files[name], name)
    sources[name] = text
  }
  return sources
}

/** Write one file through a temporary name, so a crash never leaves a half-written generated file. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const check = process.argv.includes('--check')
  const cache = resolve(root, '.cache/vendor-im', pin.commit)
  const adapter = resolve(root, 'vendor/plugin-im-adapter-lark/src')
  const target = resolve(adapter, 'types')

  if (check) await verifyCommitted(target, pin.rendered)
  await mkdir(cache, { recursive: true })
  const sources = await loadSources(cache, !check)
  if (sources === undefined) {
    console.log('gen-vendor-im-types: committed subset verified; the pinned sources are not cached, so no re-render was compared')
    return
  }
  // Handwritten consumers: every `.ts` under `src/` except the generated tree itself. Walking recursively keeps the
  // `api/` and `modes/` subdirectories in the retention closure, so a declaration only they reference survives.
  const consumers = await Promise.all((await readdir(adapter, { recursive: true }))
    .filter(name => name.endsWith('.ts') && !/(^|[\\/])types[\\/]/u.test(name))
    .sort()
    .map(name => readFile(resolve(adapter, name), 'utf8')))
  const rendered = renderLarkTypes(sources, consumers)

  if (check) {
    for (const name of files) {
      const file = resolve(target, name)
      const current = await readFile(file, 'utf8')
      if (current !== rendered[name]) {
        throw new Error(`Feishu codegen output is stale: ${file}; run pnpm run gen:vendor-im`)
      }
    }
    console.log('gen-vendor-im-types: the committed subset matches the pinned sources')
    return
  }

  await mkdir(target, { recursive: true })
  for (const name of files) {
    const file = resolve(target, name)
    let current: string | undefined
    try { current = await readFile(file, 'utf8') } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (current === rendered[name]) continue
    await writeAtomic(file, rendered[name])
  }

  const recorded = Object.fromEntries(files.map(name => [name, digestOf(rendered[name])])) as Record<SourceFile, string>
  const pinText = `${JSON.stringify({ commit: pin.commit, files: pin.files, rendered: recorded }, null, 2)}\n`
  const pinPath = resolve(root, 'scripts/vendor-im/upstream.json')
  const currentPin = await readFile(pinPath, 'utf8').catch(() => '')
  if (currentPin !== pinText) await writeAtomic(pinPath, pinText)
  console.log(`gen-vendor-im-types: ${files.length} files generated`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
