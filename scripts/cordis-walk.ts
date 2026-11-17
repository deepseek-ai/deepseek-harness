/**
 * AST helpers shared by the Cordis generators: locate the Cordis module merge
 * in a source file and enumerate the `interface Context` keys it declares.
 * The vendored core API projector consumes the merge body; the per-subsystem
 * region generator's exhaustiveness backstop consumes the key scan.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import ts from 'typescript'

/** Cheap textual prefilter for a cordis module merge, quote-style agnostic
 * (the AST match below reads `stmt.name.text` and never sees the quotes). */
const MERGE_HEAD = /declare module ['"](?:@deepseek-ai\/cordis|\.\/context\.ts)['"]/

/**
 * Parse every file matching `patterns` (repo-relative, sorted, `/`-normalized)
 * that textually contains a cordis module merge, yielding one entry per merge
 * BLOCK — a file may legally hold several `declare module '@deepseek-ai/cordis'` blocks
 * (the Typert analyzer reads them all), so the exhaustiveness scan must too.
 * Files without a merge are skipped.
 * @param scanRoot - Repository root the patterns are resolved against.
 * @param patterns - Glob(s) selecting the TypeScript files to scan.
 * @returns One entry per cordis module block, in path then source order.
 */
export function contextMergeFiles(
  scanRoot: string,
  patterns: string | readonly string[],
): { rel: string; sf: ts.SourceFile; text: string; body: ts.ModuleBlock }[] {
  const out: { rel: string; sf: ts.SourceFile; text: string; body: ts.ModuleBlock }[] = []
  const rels = [...new Set(globSync(patterns as string | string[], { cwd: scanRoot }).map(s => s.split(sep).join('/')))].sort()
  for (const rel of rels) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!MERGE_HEAD.test(text)) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    for (const body of cordisModuleBodies(sf)) out.push({ rel, sf, text, body })
  }
  return out
}

/** Every cordis module-merge body in `sf`: `declare module '@deepseek-ai/cordis'` (harness
 * packages) or `declare module './context.ts'` (vendor core), in source order.
 * Module-local: consumers walk blocks through {@link contextMergeFiles}. */
function cordisModuleBodies(sf: ts.SourceFile): ts.ModuleBlock[] {
  const bodies: ts.ModuleBlock[] = []
  for (const stmt of sf.statements) {
    if (!ts.isModuleDeclaration(stmt) || !ts.isStringLiteral(stmt.name)) continue
    if (stmt.name.text !== '@deepseek-ai/cordis' && stmt.name.text !== './context.ts') continue
    if (stmt.body && ts.isModuleBlock(stmt.body)) bodies.push(stmt.body)
  }
  return bodies
}

/** The FIRST cordis module-merge body in `sf`, or null without one — for the
 * vendor core-API renderer whose input files carry exactly one merge; the
 * exhaustiveness scan uses {@link cordisModuleBodies} to read them all. */
export function cordisModuleBody(sf: ts.SourceFile): ts.ModuleBlock | null {
  return cordisModuleBodies(sf)[0] ?? null
}

/**
 * Every `key: Type` property a `declare module '@deepseek-ai/cordis'` Context merge
 * declares in one module body.
 * @param body - The cordis module augmentation block.
 * @param sf - Owning source file (for text extraction).
 * @returns key → declared type-name text, in declaration order.
 */
export function contextKeyMap(body: ts.ModuleBlock, sf: ts.SourceFile): Map<string, string> {
  const keyToType = new Map<string, string>()
  for (const stmt of body.statements) {
    if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== 'Context') continue
    for (const member of stmt.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue
      const key = ts.isStringLiteral(member.name) || ts.isIdentifier(member.name) ? member.name.text : member.name.getText(sf)
      keyToType.set(key, member.type.getText(sf))
    }
  }
  return keyToType
}

/**
 * Every event name a `declare module '@deepseek-ai/cordis'` Events merge declares in one
 * module body. Names are the literal member keys (`'agent/created'`), read
 * from method and property members alike so a declaration form the projector
 * would reject still enters the exhaustiveness scan.
 * @param body - The cordis module augmentation block.
 * @param sf - Owning source file (for computed-name text extraction).
 * @returns Declared event names, in declaration order.
 */
export function eventNameList(body: ts.ModuleBlock, sf: ts.SourceFile): string[] {
  const names: string[] = []
  for (const stmt of body.statements) {
    if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== 'Events') continue
    for (const member of stmt.members) {
      if (!member.name) continue
      names.push(ts.isStringLiteral(member.name) || ts.isIdentifier(member.name)
        ? member.name.text
        : member.name.getText(sf))
    }
  }
  return names
}
