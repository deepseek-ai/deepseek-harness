/**
 * Generate dsh-scope's invariant resolver map from the repository TypeScript
 * Program.
 *
 * A scoped event declares `this: Scoped<Base>`. Real `scopeTarget(base, key)`
 * calls establish the routing-key type for that base. The generator searches
 * every event payload parameter and one property level for exactly one type
 * equivalent to that key. Each generated resolver compiles against the merged
 * `Events` parameter tuple. Zero matches require `@dshScopeScan unsupported`;
 * multiple matches are ambiguous and always fail loud.
 *
 *   `pnpm run gen-scoped-events`     -> write the generated source
 *   `pnpm run verify-scoped-events`  -> exit 1 when it is stale
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { pointer, rawJsDoc } from './jsdoc.ts'
import { TypeScriptProject } from './ts-project.ts'

const root = resolve(import.meta.dirname, '..')
const OUT = 'packages/core/scope/src/scoped-events.generated.ts'
const SCOPE_DOC_MARKER = 'Scope-filtered dispatch'

interface ScopeTargetContract {
  baseType: ts.Type
  keyType: ts.Type
  source: string
}

interface SubjectCandidate {
  path: string
  parameter: number
  property?: string
  type: ts.Type
}

interface ScopedEventResolver {
  event: string
  candidate: SubjectCandidate | null
}

interface ScopeTag {
  present: boolean
  unsupported: boolean
}

/** Program-backed analyzer and renderer for the generated scoped-event resolvers. */
class ScopedEventGenerator {
  private readonly checker: ts.TypeChecker
  private readonly packageSources: ts.SourceFile[]
  private readonly scopeTargetDeclaration: ts.FunctionDeclaration
  private readonly scopedSymbol: ts.Symbol
  private readonly violations: string[] = []

  constructor(private readonly project: TypeScriptProject) {
    this.checker = project.checker
    this.packageSources = project.sourceFiles().filter((sourceFile) => {
      return /^packages\/[^/]+\/[^/]+\/src\/.+\.ts$/.test(project.relativePath(sourceFile))
    })
    this.scopeTargetDeclaration = this.functionDeclaration(
      'packages/core/scope/src/index.ts',
      'scopeTarget',
    )
    this.scopedSymbol = this.typeAliasSymbol(
      'packages/core/scope/src/index.ts',
      'Scoped',
    )
  }

  /** Render the complete generated TypeScript module or throw every contract violation. */
  render(): string {
    const contracts = this.collectScopeTargetContracts()
    const resolvers = this.collectScopedEventResolvers(contracts)
    if (this.violations.length > 0) {
      throw new Error(
        `gen-scoped-events: ${this.violations.length} scoped-event contract violation(s):\n`
        + this.violations.map(violation => `  - ${violation}`).join('\n'),
      )
    }
    return [
      '/**',
      ' * Generated scoped-event routing-subject resolvers for dsh-scope invariants.',
      ' * Do not edit by hand; run `pnpm run gen-scoped-events`.',
      ' *',
      ' * @module @deepseek-ai/dsh-scope/scoped-events.generated',
      ' */',
      '',
      'type ScopedSubjectResolver = (args: readonly unknown[]) => unknown',
      '',
      'const scopedSubjectResolvers: Readonly<Record<string, ScopedSubjectResolver | null>> = Object.freeze({',
      ...resolvers.map(({ event, candidate }) => {
        if (candidate === null) return `  '${event}': null,`
        const subject = candidate.property === undefined
          ? `args[${candidate.parameter}]`
          : `(args[${candidate.parameter}] as Record<string, unknown>)[${quote(candidate.property)}]`
        return `  '${event}': args => ${subject},`
      }),
      '})',
      '',
      '/**',
      ' * Resolve the routing key named by one scoped event payload. A null',
      ' * resolver means the payload cannot expose its external routing key, so the',
      ' * invariant checks carrier presence only.',
      ' * @param event - runtime Cordis event name.',
      ' * @returns the generated subject resolver, null for presence-only,',
      ' *   or undefined when the event is not scope-filtered.',
      ' */',
      'export function scopedSubjectResolverFor(event: string): ScopedSubjectResolver | null | undefined {',
      '  return scopedSubjectResolvers[event]',
      '}',
      '',
    ].join('\n')
  }

  /** Resolve one named function declaration from a known source file. */
  private functionDeclaration(relativePath: string, name: string): ts.FunctionDeclaration {
    const sourceFile = this.project.sourceFile(relativePath)
    const declaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => {
      return ts.isFunctionDeclaration(statement) && statement.name?.text === name
    })
    if (!declaration) throw new Error(`gen-scoped-events: cannot resolve function ${name} from ${relativePath}`)
    return declaration
  }

  /** Resolve one named type-alias symbol from a known source file. */
  private typeAliasSymbol(relativePath: string, name: string): ts.Symbol {
    const sourceFile = this.project.sourceFile(relativePath)
    const declaration = sourceFile.statements.find((statement): statement is ts.TypeAliasDeclaration => {
      return ts.isTypeAliasDeclaration(statement) && statement.name.text === name
    })
    const symbol = declaration && this.checker.getSymbolAtLocation(declaration.name)
    if (!symbol) throw new Error(`gen-scoped-events: cannot resolve type ${name} from ${relativePath}`)
    return symbol
  }

  /** Collect every real scopeTarget(base, key) base/key type contract. */
  private collectScopeTargetContracts(): ScopeTargetContract[] {
    const contracts: ScopeTargetContract[] = []
    const visit = (sourceFile: ts.SourceFile, node: ts.Node): void => {
      if (ts.isCallExpression(node)
        && this.checker.getResolvedSignature(node)?.declaration === this.scopeTargetDeclaration) {
        const base = node.arguments[0]
        const key = node.arguments[1]
        if (!base || !key) {
          const source = pointer(this.project.relativePath(sourceFile), sourceFile, node)
          this.violations.push(`${source} calls scopeTarget without base and key arguments`)
        } else {
          contracts.push({
            baseType: this.checker.getTypeAtLocation(base),
            keyType: this.checker.getTypeAtLocation(key),
            source: pointer(this.project.relativePath(sourceFile), sourceFile, node),
          })
        }
      }
      ts.forEachChild(node, (child) => { visit(sourceFile, child) })
    }
    for (const sourceFile of this.packageSources) visit(sourceFile, sourceFile)
    return contracts
  }

  /** Collect every Events member and derive its generated resolver. */
  private collectScopedEventResolvers(contracts: readonly ScopeTargetContract[]): ScopedEventResolver[] {
    const resolvers: ScopedEventResolver[] = []
    for (const sourceFile of this.packageSources) {
      const rel = this.project.relativePath(sourceFile)
      const visit = (node: ts.Node): void => {
        if (ts.isInterfaceDeclaration(node) && node.name.text === 'Events' && isCordisModuleInterface(node)) {
          for (const member of node.members) {
            if (!ts.isMethodSignature(member) || !ts.isStringLiteral(member.name)) continue
            const event = member.name.text
            const raw = rawJsDoc(sourceFile.text, member)
            const where = `event '${event}' (${pointer(rel, sourceFile, member)})`
            const tag = parseScopeTag(raw, where, this.violations)
            const thisParameter = member.parameters.find(isThisParameter)
            const scopedBase = thisParameter && this.scopedBaseType(thisParameter)
            if (!scopedBase) {
              if (raw.includes(SCOPE_DOC_MARKER)) {
                this.violations.push(
                  `${where} documents scope-filtered dispatch but its signature has no this: Scoped<...> receiver`,
                )
              }
              if (tag.present) {
                this.violations.push(`${where} has @dshScopeScan metadata but is not a Scoped event`)
              }
              continue
            }
            if (!raw.includes(SCOPE_DOC_MARKER)) {
              this.violations.push(
                `${where} has this: Scoped<...> but its JSDoc does not explain "${SCOPE_DOC_MARKER}"`,
              )
            }
            const keyType = this.routingKeyType(where, scopedBase, contracts)
            if (!keyType) continue
            const candidates = this.subjectCandidates(member)
              .filter(candidate => this.typesEquivalent(candidate.type, keyType))
            if (candidates.length > 1) {
              this.violations.push(
                `${where} has multiple routing-key candidates for ${this.typeText(keyType)}: `
                + candidates.map(candidate => `${candidate.path}: ${this.typeText(candidate.type)}`).join(', '),
              )
              continue
            }
            if (candidates.length === 0) {
              if (!tag.unsupported) {
                const keyLabel = this.typeText(keyType)
                this.violations.push(
                  `${where} exposes no parameter or one-level property equivalent to routing key type ${keyLabel}; `
                  + 'add @dshScopeScan unsupported only when the key is intentionally absent from the payload',
                )
              }
              resolvers.push({ event, candidate: null })
              continue
            }
            if (tag.unsupported) {
              this.violations.push(
                `${where} has unnecessary @dshScopeScan unsupported; ${candidates[0]?.path} exposes the routing key`,
              )
              continue
            }
            resolvers.push({ event, candidate: candidates[0] ?? null })
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }
    return resolvers.sort((left, right) => left.event.localeCompare(right.event))
  }

  /** Extract the Base type from one exact this: Scoped<Base> parameter. */
  private scopedBaseType(parameter: ts.ParameterDeclaration): ts.Type | undefined {
    const type = this.checker.getTypeAtLocation(parameter)
    if (type.aliasSymbol !== this.scopedSymbol) return undefined
    return type.aliasTypeArguments?.[0]
  }

  /** Resolve one unambiguous key type for a scoped carrier base. */
  private routingKeyType(
    where: string,
    scopedBase: ts.Type,
    contracts: readonly ScopeTargetContract[],
  ): ts.Type | undefined {
    const matches = contracts.filter((contract) => {
      return this.checker.isTypeAssignableTo(this.normalizedType(contract.baseType), this.normalizedType(scopedBase))
    })
    if (matches.length === 0) {
      this.violations.push(
        `${where} has no matching scopeTarget(base, key) call for carrier base ${this.typeText(scopedBase)}`,
      )
      return undefined
    }
    const keyTypes: ts.Type[] = []
    for (const match of matches) {
      if (!keyTypes.some(type => this.typesEquivalent(type, match.keyType))) keyTypes.push(match.keyType)
    }
    if (keyTypes.length > 1) {
      this.violations.push(
        `${where} carrier base ${this.typeText(scopedBase)} has inconsistent routing-key types: `
        + matches.map(match => `${this.typeText(match.keyType)} at ${match.source}`).join(', '),
      )
      return undefined
    }
    return keyTypes[0]
  }

  /** Enumerate every payload parameter and every accessible one-level property. */
  private subjectCandidates(member: ts.MethodSignature): SubjectCandidate[] {
    const candidates: SubjectCandidate[] = []
    let runtimeIndex = 0
    for (const parameter of member.parameters) {
      if (isThisParameter(parameter)) continue
      const directPath = `args[${runtimeIndex}]`
      const parameterType = this.checker.getTypeAtLocation(parameter)
      candidates.push({ path: directPath, parameter: runtimeIndex, type: parameterType })
      for (const property of this.checker.getPropertiesOfType(this.normalizedType(parameterType))) {
        const name = property.getName()
        if (name.startsWith('__@') || hasNonPublicDeclaration(property)) continue
        candidates.push({
          path: `${directPath}.${name}`,
          parameter: runtimeIndex,
          property: name,
          type: this.checker.getTypeOfSymbolAtLocation(property, parameter),
        })
      }
      runtimeIndex += 1
    }
    return dedupeCandidates(candidates)
  }

  /** Compare exact Program type identities after removing null and undefined. */
  private typesEquivalent(left: ts.Type, right: ts.Type): boolean {
    const normalizedLeft = this.normalizedType(left)
    const normalizedRight = this.normalizedType(right)
    if (normalizedLeft.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false
    if (normalizedRight.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false
    return normalizedLeft === normalizedRight
  }

  /** Remove null and undefined from a routing or candidate type. */
  private normalizedType(type: ts.Type): ts.Type {
    return this.checker.getNonNullableType(type)
  }

  /** Render a stable diagnostic type label. */
  private typeText(type: ts.Type): string {
    return this.checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
  }
}

/** Return whether an Events interface is inside declare module '@deepseek-ai/cordis'. */
function isCordisModuleInterface(node: ts.InterfaceDeclaration): boolean {
  const block = node.parent
  const declaration = block.parent
  return ts.isModuleBlock(block)
    && ts.isModuleDeclaration(declaration)
    && ts.isStringLiteral(declaration.name)
    && declaration.name.text === '@deepseek-ai/cordis'
}

/** Return whether a parameter is the explicit TypeScript this receiver. */
function isThisParameter(parameter: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(parameter.name) && parameter.name.text === 'this'
}

/** Parse and validate the optional @dshScopeScan unsupported tag. */
function parseScopeTag(raw: string, where: string, violations: string[]): ScopeTag {
  const tags = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(line => line.replace(/^\s*\*?\s?/, '').trim())
    .filter(line => line.startsWith('@dshScopeScan'))
  if (tags.length > 1) violations.push(`${where} has multiple @dshScopeScan tags`)
  if (tags.length === 0) return { present: false, unsupported: false }
  const unsupported = tags[0] === '@dshScopeScan unsupported'
  if (!unsupported) {
    violations.push(
      `${where} has invalid scoped-event scan metadata '${tags[0]}'; expected '@dshScopeScan unsupported'`,
    )
  }
  return { present: true, unsupported }
}

/** Return whether a property has a private or protected declaration. */
function hasNonPublicDeclaration(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) => {
    if (!ts.canHaveModifiers(declaration)) return false
    return ts.getModifiers(declaration)?.some((modifier) => {
      return modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword
    }) ?? false
  })
}

/** Deduplicate candidate paths contributed by merged/intersection types. */
function dedupeCandidates(candidates: readonly SubjectCandidate[]): SubjectCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false
    seen.add(candidate.path)
    return true
  })
}

/** Quote a generated property key as a single-quoted TypeScript string. */
function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

/**
 * Render the generated scoped-event resolver module for one repository root.
 * @param projectRoot - repository root carrying tsconfig.host.json.
 * @returns complete generated TypeScript source.
 */
export function renderScopedEvents(projectRoot: string = root): string {
  return new ScopedEventGenerator(new TypeScriptProject(projectRoot)).render()
}

/** Generate or freshness-check the fixed dsh-scope source file. */
function main(): void {
  const content = renderScopedEvents()
  const output = resolve(root, OUT)
  if (process.argv.includes('--check')) {
    const committed = existsSync(output) ? readFileSync(output, 'utf8') : null
    if (committed === content) {
      console.log(`gen-scoped-events: ${OUT} is up to date.`)
      return
    }
    console.error(`gen-scoped-events: ${OUT} is stale. Run \`pnpm run gen-scoped-events\` and commit it.`)
    process.exit(1)
  }
  writeFileSync(output, content)
  console.log(`gen-scoped-events: wrote ${OUT}.`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
