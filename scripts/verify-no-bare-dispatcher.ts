/**
 * Verify that no package builds its own undici agent or hands `fetch` an explicit dispatcher.
 *
 * Node's built-in `fetch` routes through undici's global dispatcher, which `@deepseek-ai/dsh-http-proxy`
 * installs at launch. An explicitly supplied `dispatcher` overrides that global one, so a call site
 * that constructs `new Agent(...)` itself connects directly no matter what proxy the user configured
 * — the exact defect `web-fetch-http` carried before proxy support existed, where its DNS-pinning
 * agent silently bypassed every proxy.
 *
 * `proxyRouteFor(url)` from that package is the sanctioned way to ask where one request goes and to
 * get the transport that answer assumed. A call site that genuinely owns its transport — because it
 * carries per-request state the process-wide dispatcher cannot, as `web-fetch-http`'s address
 * pinning does — says so with the marker below.
 *
 * Discovery is syntax-aware, as `scripts/AGENTS.md` requires: a line-wise regex misses the
 * `{ dispatcher }` shorthand and a `new Alias(...)` whose import renamed `Agent`, and both bypass the
 * proxy exactly as the spelled-out forms do. Bindings from a dynamic `await import('undici')` count
 * the same as static ones — that is how this repository loads undici wherever the transport must
 * stay out of a browser-worker's startup graph.
 */

import { globSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')

/** The package that owns dispatcher construction; its own agents are the implementation. */
export const DISPATCHER_OWNER = 'packages/util/http-proxy/'

/**
 * A comment carrying this marker states why the construction or option is exempt. It counts on the
 * offending line or the line directly above it, because a syntax-aware match anchors on the property
 * or `new` expression rather than the statement, and the explanation belongs above a long line.
 */
export const ALLOW_MARKER = 'proxy-exempt:'

/** Undici agent classes whose construction selects a transport, under any local name. */
const AGENT_EXPORTS = new Set(['Agent', 'ProxyAgent', 'EnvHttpProxyAgent'])

/** The module those classes must come from; a same-named class from elsewhere selects no transport. */
const AGENT_MODULE = 'undici'

/** The request option that overrides the global dispatcher, however it is written. */
const DISPATCHER_PROPERTY = 'dispatcher'

/** One source position that would bypass the configured proxy. */
export interface DispatcherViolation {
  /** Repository-relative path, in POSIX separators. */
  readonly file: string
  /** One-based line number. */
  readonly line: number
  /** Which rule the position broke. */
  readonly what: string
  /** The offending source text, trimmed. */
  readonly text: string
}

/**
 * Whether an expression is `import('undici')`, with or without `await`. The dynamic form is how
 * this repository loads undici everywhere the transport must stay out of a browser-worker's startup
 * graph, so a gate blind to it would miss the repository's own idiom.
 *
 * @param expression - a variable declaration's initializer, when it has one.
 * @returns true when evaluating it yields the undici module.
 */
function isUndiciImport(expression: ts.Expression | undefined): boolean {
  if (expression === undefined) return false
  const call = ts.isAwaitExpression(expression) ? expression.expression : expression
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return false
  const [specifier] = call.arguments
  return specifier !== undefined && ts.isStringLiteral(specifier) && specifier.text === AGENT_MODULE
}

/**
 * Record the names one destructured dynamic import binds to an agent class.
 *
 * @param pattern - the binding pattern of `const { Agent, ProxyAgent: P } = await import('undici')`.
 * @param agents - collector the local names are added to.
 */
function collectDestructuredAgents(pattern: ts.ObjectBindingPattern, agents: Set<string>): void {
  for (const element of pattern.elements) {
    if (!ts.isIdentifier(element.name)) continue
    const property = element.propertyName
    const imported = property === undefined
      ? element.name.text
      : ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : undefined
    if (imported !== undefined && AGENT_EXPORTS.has(imported)) agents.add(element.name.text)
  }
}

/**
 * Local names bound to an undici agent class, including `import { Agent as X }` renames, the
 * destructured and namespace forms of a dynamic `import('undici')`, and a namespace import's own
 * name so `undici.Agent` is recognised too.
 *
 * @param source - the parsed file.
 * @returns agent identifiers and namespace identifiers bound in this file.
 */
function agentBindings(source: ts.SourceFile): { agents: Set<string>; namespaces: Set<string> } {
  const agents = new Set<string>()
  const namespaces = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === AGENT_MODULE) {
        const bindings = node.importClause?.namedBindings
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
        else if (bindings !== undefined) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text
            if (AGENT_EXPORTS.has(imported)) agents.add(element.name.text)
          }
        }
      }
    } else if (ts.isVariableDeclaration(node) && isUndiciImport(node.initializer)) {
      if (ts.isIdentifier(node.name)) namespaces.add(node.name.text)
      else if (ts.isObjectBindingPattern(node.name)) collectDestructuredAgents(node.name, agents)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return { agents, namespaces }
}

/**
 * Whether an expression names an undici agent class: a bound identifier, or a `<namespace>.Agent`
 * property access.
 *
 * @param expression - the `new` expression's callee.
 * @param bound - identifiers this file bound to an agent class or a namespace.
 * @returns true when constructing it selects a transport.
 */
function namesAgent(expression: ts.Expression, bound: ReturnType<typeof agentBindings>): boolean {
  if (ts.isIdentifier(expression)) return bound.agents.has(expression.text)
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return bound.namespaces.has(expression.expression.text) && AGENT_EXPORTS.has(expression.name.text)
  }
  return false
}

/**
 * Whether an object literal member supplies `dispatcher`, covering `dispatcher: x`, the `{ dispatcher }`
 * shorthand, and `{ 'dispatcher': x }`.
 *
 * @param member - one object-literal element.
 * @returns true when the member names the dispatcher option.
 */
function suppliesDispatcher(member: ts.ObjectLiteralElementLike): boolean {
  if (ts.isShorthandPropertyAssignment(member)) return member.name.text === DISPATCHER_PROPERTY
  if (!ts.isPropertyAssignment(member)) return false
  const name = member.name
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === DISPATCHER_PROPERTY
  return false
}

/**
 * Find every bare-dispatcher position in one source file.
 *
 * @param file - repository-relative path, used to exempt the owning package and to report location.
 * @param sourceText - the file's contents.
 * @returns one violation per offending position, in source order.
 */
export function findDispatcherViolations(file: string, sourceText: string): DispatcherViolation[] {
  const posix = file.replaceAll('\\', '/')
  if (posix.startsWith(DISPATCHER_OWNER)) return []
  // Both violations name one of these two words in source: an agent construction needs a binding
  // from the undici module, and the option is a property called `dispatcher`. Parsing the rest of
  // the repository anyway made this the slowest gate — 21 of 1597 files survive the filter.
  if (!sourceText.includes(AGENT_MODULE) && !sourceText.includes(DISPATCHER_PROPERTY)) return []
  const source = ts.createSourceFile(posix, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bound = agentBindings(source)
  const lines = sourceText.split('\n')
  const violations: DispatcherViolation[] = []

  const record = (node: ts.Node, what: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
    const exempt = [lines[line], lines[line - 1]].some(text => text?.includes(ALLOW_MARKER) === true)
    if (exempt) return
    violations.push({ file: posix, line: line + 1, what, text: (lines[line] ?? '').trim() })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && namesAgent(node.expression, bound)) {
      record(node, 'constructs an undici agent')
    }
    if (ts.isObjectLiteralExpression(node) && node.properties.some(suppliesDispatcher)) {
      record(node.properties.find(suppliesDispatcher) as ts.Node, 'passes an explicit `dispatcher`')
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return violations
}

/**
 * Scan every package and app source file in the repository.
 *
 * @returns every violation found, in scan order.
 * @throws when the corpus is empty, which would make the gate pass by scanning nothing.
 */
export function scanRepository(): DispatcherViolation[] {
  const files = [
    ...globSync('packages/*/*/src/**/*.ts', { cwd: root }),
    ...globSync('apps/*/src/**/*.ts', { cwd: root }),
  ]
  if (files.length === 0) throw new Error('verify-no-bare-dispatcher: scanned an empty corpus; the globs no longer match.')
  return files.flatMap(file => findDispatcherViolations(file, readFileSync(resolve(root, file), 'utf8')))
}

function main(): void {
  const violations = scanRepository()
  if (violations.length === 0) {
    console.log(`verify-no-bare-dispatcher: no bare dispatcher outside ${DISPATCHER_OWNER}.`)
    return
  }
  console.error('verify-no-bare-dispatcher: a dispatcher built outside @deepseek-ai/dsh-http-proxy bypasses the configured proxy.\n')
  for (const violation of violations) {
    console.error(`  ${relative('.', violation.file)}:${String(violation.line)} ${violation.what}`)
    console.error(`    ${violation.text}`)
  }
  console.error('\nUse `proxyRouteFor(url)` from @deepseek-ai/dsh-http-proxy, or annotate the line')
  console.error(`with a \`${ALLOW_MARKER} <reason>\` comment when the request must genuinely ignore the proxy.`)
  process.exit(1)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
