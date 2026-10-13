/**
 * Verify every `ts type-equiv` and `ts public-api` block against the source
 * symbol named by the manifest. Ordinary entries preserve the complete
 * declaration; `public-api` entries preserve a class's body-stripped public
 * declaration. Blocks and entries have a one-to-one relationship; comparison
 * ignores whitespace and non-JSDoc comments but preserves declaration
 * structure and every original JSDoc comment. Byte-identical `.zh.md` blocks
 * reuse the manifest-backed check of their unsuffixed sibling.
 */

import { globSync, readFileSync, existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import ts from 'typescript'
import { markdownFences } from './markdown.ts'
import { partitionPairedMarkdownDerivatives } from './paired-markdown-derivatives.ts'
import { isArchivedAgentNotePath } from './repo-files.ts'
import { mayContainEquivFence } from './type-equiv-prefilter.ts'

const root = resolve(import.meta.dirname, '..')

/** Scan doc-typecheck's full Markdown scope so unmanifested blocks also fail. */
const MARKDOWN_GLOBS = ['README.md', '.agents/notes/**/*.md', 'docs/**/*.md', 'packages/*/*.md', 'packages/*/*/*.md']

/** One manifest entry: a source-equivalence block and its source symbol. */
interface ManifestEntry {
  /** Doc file (repo-relative) containing the source-equivalence block. */
  doc: string
  /** The declared symbol the block must match (e.g. `SessionEvent`). */
  symbol: string
  /** Source file (repo-relative) that exports the symbol. */
  source: string
  /** Explicit module augmentations whose members complete an interface. */
  augmentations?: Array<{
    /** Source file (repo-relative) containing the augmentation. */
    source: string
    /** String-literal module specifier containing the merged interface. */
    module: string
  }>
  /** Complete declaration (default), or a body-stripped public class API. */
  projection?: 'public-api'
}

/** One extracted ` ```ts type-equiv ` or ` ```ts public-api ` block. */
interface EquivBlock {
  doc: string
  /** 1-based line of the opening fence (for diagnostics). */
  line: number
  /** Symbol name parsed from the block's declaration. */
  symbol: string
  /** Complete declaration (default), or a body-stripped public class API. */
  projection?: 'public-api'
  /** Block body (the pasted declaration). */
  code: string
}

/** Normalize declaration structure independently of comments and whitespace. */
function normalizeStructure(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract normalized JSDoc comments in source order. Type declarations in this
 * repository do not contain comment delimiters inside string literals.
 */
function normalizeJSDoc(code: string): string[] {
  return [...code.matchAll(/\/\*\*[\s\S]*?\*\//g)]
    .map(match => match[0].replace(/\s+/g, ' ').trim())
}

/** Strip source-only export modifiers. */
function stripExport(code: string): string {
  return code.replace(/^export\s+(default\s+)?/, '')
}

/** Parse the declared symbol name from a source-equivalence block body. */
function blockSymbol(code: string): string | null {
  const sf = ts.createSourceFile('type-equiv.ts', code, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TS)
  for (const stmt of sf.statements) {
    const named =
      ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)
      || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)
    if (named && stmt.name) return stmt.name.text
  }
  return null
}

/** Extract every source-equivalence block from one Markdown file. */
function extractEquivBlocks(docRel: string): EquivBlock[] {
  const blocks: EquivBlock[] = []
  const source = readFileSync(resolve(root, docRel), 'utf8')
  if (!mayContainEquivFence(source)) return blocks
  for (const fence of markdownFences(source)) {
    if (fence.info === 'ts type-equiv public-api') {
      throw new Error(`verify-type-equiv: ${docRel}:${fence.line} — use the concise \`ts public-api\` fence`)
    }
    if (fence.info !== 'ts type-equiv' && fence.info !== 'ts public-api') continue
    if (!fence.closed) {
      throw new Error(`verify-type-equiv: ${docRel}:${fence.line} — unterminated type-equivalence fence (missing closing \`\`\`)`)
    }
    const symbol = blockSymbol(fence.code)
    if (symbol === null) {
      throw new Error(`verify-type-equiv: ${docRel}:${fence.line} — type-equiv block has no parseable interface/type/class declaration`)
    }
    blocks.push({
      doc: docRel,
      line: fence.line,
      symbol,
      code: fence.code,
      ...(fence.info === 'ts public-api' ? { projection: 'public-api' as const } : {}),
    })
  }
  return blocks
}

/** One manifest source file's text and its parse. */
interface ParsedSource {
  text: string
  sourceFile: ts.SourceFile
}

/** Parsed manifest sources by absolute path; declaration extraction only reads them. */
const parsedSources = new Map<string, ParsedSource>()

/** Read and parse one manifest source file at most once per run. */
function parsedSource(sourceRel: string): ParsedSource {
  const abs = resolve(root, sourceRel)
  const cached = parsedSources.get(abs)
  if (cached !== undefined) return cached
  const text = readFileSync(abs, 'utf8')
  const parsed = { text, sourceFile: ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, /* setParentNodes */ true) }
  parsedSources.set(abs, parsed)
  return parsed
}

/**
 * The declaration text of `symbol` in `sourceRel`, with `export` stripped, or
 * null when the symbol is not declared there. Uses the TS parser so it spans
 * interfaces, type aliases (including mapped/generic ones), classes, and enums
 * uniformly while including declaration and member JSDoc.
 */
function sourceDeclaration(sourceRel: string, symbol: string): string | null {
  const { text, sourceFile: sf } = parsedSource(sourceRel)
  for (const stmt of sf.statements) {
    const named =
      ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)
      || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)
    if (named && stmt.name?.text === symbol) {
      const declarationStart = stmt.getStart(sf)
      const jsDoc = ts.getJSDocCommentsAndTags(stmt)
        .filter(ts.isJSDoc)
        .map(doc => text.slice(doc.pos, doc.end))
        .join('\n')
      const declaration = stripExport(text.slice(declarationStart, stmt.getEnd()))
      return jsDoc === '' ? declaration : `${jsDoc}\n${declaration}`
    }
  }
  return null
}

interface InterfacePart {
  text: string
  sourceFile: ts.SourceFile
  declaration: ts.InterfaceDeclaration
}

/** Find one top-level interface declaration in a source file. */
function sourceInterface(sourceRel: string, symbol: string): InterfacePart | null {
  const { text, sourceFile } = parsedSource(sourceRel)
  const declaration = sourceFile.statements.find((statement): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === symbol,
  )
  return declaration === undefined ? null : { text, sourceFile, declaration }
}

/** Find one interface declaration inside an explicit string-literal module augmentation. */
function augmentedInterface(sourceRel: string, moduleName: string, symbol: string): InterfacePart | null {
  const { text, sourceFile } = parsedSource(sourceRel)
  for (const statement of sourceFile.statements) {
    if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)
      || statement.name.text !== moduleName || !statement.body || !ts.isModuleBlock(statement.body)) continue
    const declaration = statement.body.statements.find((member): member is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(member) && member.name.text === symbol,
    )
    if (declaration !== undefined) return { text, sourceFile, declaration }
  }
  return null
}

/** Render one interface plus explicitly named module augmentations as its merged declaration. */
function mergedInterfaceDeclaration(entry: ManifestEntry): string | null {
  const base = sourceInterface(entry.source, entry.symbol)
  if (base === null) return null
  const additions: InterfacePart[] = []
  for (const augmentation of entry.augmentations ?? []) {
    const part = augmentedInterface(augmentation.source, augmentation.module, entry.symbol)
    if (part === null) return null
    additions.push(part)
  }

  const parts = [base, ...additions]
  const docs = parts.map(part => sourceJSDoc(part.text, part.declaration)).filter(Boolean)
  const typeParameters = base.declaration.typeParameters
    ?.map(parameter => parameter.getText(base.sourceFile)).join(', ')
  const heritage = parts.flatMap(part =>
    part.declaration.heritageClauses?.map(clause => clause.getText(part.sourceFile)) ?? [],
  ).join(' ')
  const header = `interface ${entry.symbol}${typeParameters ? `<${typeParameters}>` : ''}${heritage ? ` ${heritage}` : ''} {`
  const members = parts.flatMap(part => part.declaration.members.map((member) => {
    const jsDoc = sourceJSDoc(part.text, member)
    const declaration = part.text.slice(member.getStart(part.sourceFile), member.getEnd())
    return jsDoc === '' ? declaration : `${jsDoc}\n${declaration}`
  }))
  const declaration = [header, ...members.map(member => member.split('\n').map(line => `  ${line}`).join('\n')), '}'].join('\n')
  return docs.length === 0 ? declaration : `${docs.join('\n')}\n${declaration}`
}

/** Leading source JSDoc attached to one declaration or member. */
function sourceJSDoc(text: string, node: ts.Node): string {
  return ts.getJSDocCommentsAndTags(node)
    .filter(ts.isJSDoc)
    .map(doc => text.slice(doc.pos, doc.end))
    .join('\n')
}

/** Whether a class member is part of its public declaration. */
function isPublicMember(member: ts.ClassElement): boolean {
  if (ts.isClassStaticBlockDeclaration(member)) return false
  const name = ts.getNameOfDeclaration(member)
  if (name && ts.isPrivateIdentifier(name)) return false
  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined
  return !(modifiers?.some(modifier =>
    modifier.kind === ts.SyntaxKind.PrivateKeyword
    || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  ) ?? false)
}

/** Remove an implementation body while retaining the source signature. */
function bodylessMember(text: string, sf: ts.SourceFile, member: ts.ClassElement): string {
  const start = member.getStart(sf)
  let end = member.end
  if (ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member)
    || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    if (member.body) end = member.body.getStart(sf)
  }
  if (ts.isPropertyDeclaration(member) && member.initializer) end = member.initializer.getStart(sf)
  const signature = text.slice(start, end).trimEnd().replace(/;$/, '').replace(/=\s*$/, '').trimEnd()
  return `${signature};`
}

/**
 * Render a class as an ambient declaration containing only its public fields,
 * constructor, accessors, and methods. Implementation bodies and private or
 * protected members are deliberately absent; original class/member JSDoc is
 * retained so the projection is the source-owned public contract.
 */
function sourcePublicApi(sourceRel: string, symbol: string): string | null {
  const { text, sourceFile: sf } = parsedSource(sourceRel)
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || stmt.name?.text !== symbol) continue
    const classDoc = sourceJSDoc(text, stmt)
    const abstract = stmt.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AbstractKeyword) ? 'abstract ' : ''
    const typeParameters = stmt.typeParameters?.map(parameter => parameter.getText(sf)).join(', ')
    const heritage = stmt.heritageClauses?.map(clause => clause.getText(sf)).join(' ')
    const header = `declare ${abstract}class ${symbol}${typeParameters ? `<${typeParameters}>` : ''}${heritage ? ` ${heritage}` : ''} {`
    const members = stmt.members
      .filter(isPublicMember)
      .map((member) => {
        const jsDoc = sourceJSDoc(text, member)
        const declaration = bodylessMember(text, sf, member)
        return jsDoc === '' ? declaration : `${jsDoc}\n${declaration}`
      })
    const declaration = [header, ...members.map(member => member.split('\n').map(line => `  ${line}`).join('\n')), '}'].join('\n')
    return classDoc === '' ? declaration : `${classDoc}\n${declaration}`
  }
  return null
}

const manifestRaw = readFileSync(resolve(root, 'scripts/type-equiv.manifest.json'), 'utf8')
const manifest = JSON.parse(manifestRaw) as { entries: ManifestEntry[] }
const entries = manifest.entries

// Key a block/entry by doc + symbol + projection. A symbol may be documented in
// more than one doc, and a doc may carry both complete and projected forms.
const keyOf = (x: { doc: string; symbol: string; projection?: 'public-api' }): string =>
  `${x.doc}::${x.symbol}::${x.projection ?? 'declaration'}`

// Collect every type-equiv block across ALL docs in scope — not only the docs
// the manifest names — so a block in an unmanifested doc is found and reported
// as an orphan rather than silently skipped.
const docSet = new Set<string>()
for (const pattern of MARKDOWN_GLOBS) {
  for (const match of globSync(pattern, { cwd: root })) {
    const normalized = match.split(sep).join('/')
    if (!isArchivedAgentNotePath(normalized)) docSet.add(normalized)
  }
}
const extractedBlocks: EquivBlock[] = [...docSet].sort().flatMap(extractEquivBlocks)
const { primary: blocks, derivatives } = partitionPairedMarkdownDerivatives(
  extractedBlocks,
  block => block.doc,
  block => `${block.projection ?? 'declaration'}\0${block.code}`,
)

const errors: string[] = []
// A manifest entry naming a doc that does not exist (or is outside the scanned
// scope, so no block could ever match it) is an error in its own right.
for (const d of [...new Set(entries.map(e => e.doc))]) {
  if (!existsSync(resolve(root, d))) errors.push(`manifest references ${d}, which does not exist`)
  else if (!docSet.has(d)) errors.push(`manifest references ${d}, which is outside the scanned markdown scope (${MARKDOWN_GLOBS.join(', ')})`)
}

// Duplicate-block guard: the same projected symbol twice in one doc is ambiguous.
const blockByKey = new Map<string, EquivBlock>()
for (const b of blocks) {
  const k = keyOf(b)
  const prior = blockByKey.get(k)
  if (prior) {
    errors.push(`duplicate type-equiv block for ${b.symbol} in ${b.doc} (lines ${prior.line} and ${b.line})`)
    continue
  }
  blockByKey.set(k, b)
}

// Duplicate-entry guard in the manifest.
const entryByKey = new Map<string, ManifestEntry>()
for (const e of entries) {
  const k = keyOf(e)
  if (entryByKey.has(k)) {
    errors.push(`duplicate manifest entry for ${e.symbol} in ${e.doc}`)
    continue
  }
  entryByKey.set(k, e)
}

// 1:1 correspondence: orphan blocks (no entry) and orphan entries (no block).
for (const b of blocks) {
  if (!entryByKey.has(keyOf(b))) {
    errors.push(`type-equiv block ${b.symbol} (${b.doc}:${b.line}) has no manifest entry — add one to scripts/type-equiv.manifest.json`)
  }
}
for (const e of entries) {
  if (!blockByKey.has(keyOf(e))) {
    errors.push(`manifest entry ${e.symbol} (${e.doc}) has no matching type-equiv block — remove it or add the block`)
  }
}

// Verbatim check: each matched block must equal its source declaration.
let verified = 0
for (const e of entries) {
  const b = blockByKey.get(keyOf(e))
  if (!b) continue // already reported as an orphan entry
  const decl = e.augmentations !== undefined
    ? mergedInterfaceDeclaration(e)
    : e.projection === 'public-api'
      ? sourcePublicApi(e.source, e.symbol)
      : sourceDeclaration(e.source, e.symbol)
  if (decl === null) {
    errors.push(`symbol ${e.symbol} not found in ${e.source} (manifest entry for ${e.doc})`)
    continue
  }
  const doc = stripExport(b.code)
  const sourceStructure = normalizeStructure(decl)
  const docStructure = normalizeStructure(doc)
  const sourceJSDoc = normalizeJSDoc(decl)
  const docJSDoc = normalizeJSDoc(doc)
  if (sourceStructure !== docStructure || JSON.stringify(sourceJSDoc) !== JSON.stringify(docJSDoc)) {
    errors.push(
      `DRIFT: ${e.doc}:${b.line} — type-equiv block for ${e.symbol} does not match ${e.source}.\n`
      + `    source structure: ${sourceStructure}\n`
      + `    doc structure:    ${docStructure}\n`
      + `    source JSDoc:     ${JSON.stringify(sourceJSDoc)}\n`
      + `    doc JSDoc:        ${JSON.stringify(docJSDoc)}`,
    )
    continue
  }
  verified++
}

if (errors.length === 0) {
  console.log(`verify-type-equiv: ${verified} type-equiv block(s) match source structure and JSDoc (1:1 with manifest); ${derivatives.length} paired derivative(s).`)
  process.exit(0)
}

console.error('verify-type-equiv: type-equiv verification failed:')
for (const e of errors) console.error(`  ${e}`)
console.error(`\n(checked ${blocks.length} primary block(s) across ${new Set(blocks.map(b => b.doc)).size} doc(s), ${derivatives.length} paired derivative(s); manifest at scripts/type-equiv.manifest.json)`)
process.exit(1)
