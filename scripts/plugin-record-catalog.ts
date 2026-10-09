/** Discover package-owned experimental Session records without adding persistence schema roots. */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import ts from 'typescript'
import { experimentalPackageRecordNamespace } from './experimental-package-policy.ts'
import { parseJsDoc, pointer, rawJsDoc, reportViolations } from './jsdoc.ts'

const SESSION_PACKAGE = '@deepseek-ai/dsh-session'
const SESSION_TYPES_MODULE = `${SESSION_PACKAGE}/types`
const RECORD_NAME = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/u
const printer = ts.createPrinter({ removeComments: true })

/** One current-source plugin record declaration, independent of compatibility history. */
export interface PluginRecordEntry {
  /** Literal stored record name. */
  readonly name: string
  /** Owning workspace package's npm name. */
  readonly owner: string
  /** Authored payload annotation, without resolving referenced types. */
  readonly payload: string
  /** Declaration JSDoc description. */
  readonly doc: string
  /** Repository-relative declaration file, without a line number. */
  readonly source: string
}

/** Read package ownership from the source file's workspace manifest. */
function packageName(source: string, root: string): string | undefined {
  const manifest: unknown = JSON.parse(readFileSync(resolve(root, source.split('/').slice(0, 3).join('/'), 'package.json'), 'utf8'))
  return typeof manifest === 'object' && manifest !== null && 'name' in manifest && typeof manifest.name === 'string'
    ? manifest.name : undefined
}

/** Print compact type syntax while preserving whitespace within literal values. */
function payloadText(type: ts.TypeNode, source: ts.SourceFile): string {
  const singleLine = (node: ts.Node): void => {
    ts.setEmitFlags(node, ts.EmitFlags.SingleLine)
    ts.forEachChild(node, singleLine)
  }
  singleLine(type)
  return printer.printNode(ts.EmitHint.Unspecified, type, source).trim()
}

/**
 * Collect documented `PluginRecordMap` augmentations from production package source.
 * @param scanRoot - repository root containing the owning empty map and package manifests.
 * @returns unique record declarations sorted by owner and name, with unexpanded payload annotations.
 * @throws when ownership, namespace, declaration syntax, or description requirements fail.
 */
export function collectPluginRecords(scanRoot: string): PluginRecordEntry[] {
  const entries: PluginRecordEntry[] = []
  const violations: string[] = []
  const seen = new Map<string, string>()
  let owningDeclaration: string | undefined
  const files = globSync('packages/*/*/src/**/*.{ts,tsx,mts,cts}', { cwd: scanRoot })
    .map(file => file.split(sep).join('/')).sort()
  for (const file of files) {
    const text = readFileSync(resolve(scanRoot, file), 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'PluginRecordMap') {
        ts.forEachChild(node, visit)
        return
      }
      const where = `PluginRecordMap (${pointer(file, source, node)})`
      let owner: string | undefined
      try {
        owner = packageName(file, scanRoot)
      } catch (error: unknown) {
        violations.push(`${where} has no readable package ownership: ${String(error)}`)
        return
      }
      if (node.heritageClauses?.length || node.typeParameters?.length) {
        violations.push(`${where} must declare record properties directly, without extends or type parameters.`)
      }
      if (ts.isSourceFile(node.parent)) {
        if (!file.startsWith('packages/core/session/src/') || owner !== SESSION_PACKAGE) {
          violations.push(`${where} is outside ${SESSION_PACKAGE}; contribute records through declare module '${SESSION_TYPES_MODULE}'.`)
        } else if (!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          violations.push(`${where} must export the owning empty interface.`)
        } else if (owningDeclaration !== undefined) {
          violations.push(`${where} duplicates the owning declaration at ${owningDeclaration}.`)
        } else {
          owningDeclaration = pointer(file, source, node)
        }
        if (node.members.length > 0) violations.push(`${where} must remain empty; experimental packages own record declarations.`)
        return
      }
      const container = node.parent
      const module = ts.isModuleBlock(container) ? container.parent : undefined
      if (module === undefined || !ts.isModuleDeclaration(module) || !ts.isStringLiteral(module.name)
        || module.name.text !== SESSION_TYPES_MODULE || !ts.isSourceFile(module.parent)) {
        violations.push(`${where} must augment declare module '${SESSION_TYPES_MODULE}'.`)
        return
      }
      const namespace = owner === undefined ? undefined : experimentalPackageRecordNamespace(owner)
      if (!file.startsWith('packages/experimental/') || owner === undefined || namespace === undefined) {
        violations.push(`${where} must belong to a package declared experimental by the package naming policy.`)
        return
      }
      const prefix = `plugin:${namespace}/`
      for (const member of node.members) {
        const location = pointer(file, source, member)
        if (!ts.isPropertySignature(member) || member.type === undefined || member.questionToken !== undefined
          || !ts.isStringLiteral(member.name)) {
          violations.push(`plugin record at ${location} must be a required string-literal property with an explicit payload type.`)
          continue
        }
        const name = member.name.text
        if (!RECORD_NAME.test(name) || !name.startsWith(prefix)) {
          violations.push(`plugin record '${name}' (${location}) must use '${prefix}<name>' with lowercase slash-separated segments.`)
          continue
        }
        const prior = seen.get(name)
        if (prior !== undefined) {
          violations.push(`plugin record '${name}' (${location}) is already declared at ${prior}.`)
          continue
        }
        seen.set(name, location)
        const { doc, hasMode } = parseJsDoc(rawJsDoc(text, member))
        if (doc === '') violations.push(`plugin record '${name}' (${location}) has no description prose.`)
        if (hasMode) violations.push(`plugin record '${name}' (${location}) must not carry a Cordis @mode tag.`)
        const payload = payloadText(member.type, source)
        entries.push({ name, owner, payload, doc, source: file })
      }
    }
    visit(source)
  }
  if (owningDeclaration === undefined) violations.push(`missing exported empty PluginRecordMap in ${SESSION_PACKAGE}.`)
  reportViolations('plugin-record-catalog', violations)
  return entries.sort((left, right) => left.owner.localeCompare(right.owner) || left.name.localeCompare(right.name))
}
