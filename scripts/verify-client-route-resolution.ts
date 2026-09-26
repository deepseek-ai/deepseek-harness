/**
 * Browser-face route gate: an app-owned route reachable from browser code is
 * document-relative. Only request targets are governed: a root-absolute
 * (`/api/x`), protocol-relative (`//host/api/x`) or absolute
 * (`https://host/api/x`) app route used to address a resource binds the bundle
 * to one mount, and a relative app route resolved against a `location` read
 * rebuilds the base the served document already provides. A request target is
 * the first argument of a request constructor, of a `fetch`/`fetcher` callee,
 * or of a dynamic import; an assigned resource property (`script.src = ...`);
 * or a JSX `src`/`href` attribute.
 *
 * Route keys stay absolute pathnames — the RPC channel key, the path a route is
 * registered under, and the shared `*_PATH`/`*_ENDPOINT` constants carrying
 * them — so a literal that is not a request target is out of scope. A browser
 * half addresses such a key by stripping its leading slash, which the shared-key
 * rule below requires.
 *
 * The static producers of browser references are checked in the same pass: a
 * field the browser resolves against its document (`url`, `src`, `href`)
 * must not be stamped with a root-absolute app route. Internal route keys and
 * response-table keys stay absolute and are not references. This rule reads
 * inline literal fragments only, so a composed reference
 * (`comboReference(...)`, `artifact.url.slice(1)`) is not traced:
 * `packages/client/modules/tests/node-half.client.spec.ts` owns the regression
 * signal for composed graph rows, batch descriptors, and the source-map trailer.
 *
 * Rationale: .agents/notes/implemented/architecture/2026-09-17-web-feature-routes-and-route-gate.md.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { faceConfigs } from './ts-project.ts'

const root = resolve(import.meta.dirname, '..')
const GATE = 'verify-client-route-resolution'
/** App-owned route prefixes; a foreign path (`/assets/x`) is not governed here. */
const APP_ROUTE_PREFIX = '(?:api|plugins|open-in-app)(?:/|$)'
/** A root-absolute or protocol-relative app route literal. */
const ROOT_ABSOLUTE_ROUTE = new RegExp(`^/{1,2}${APP_ROUTE_PREFIX}`)
/** An absolute or protocol-relative app route literal on any origin or scheme. */
const ABSOLUTE_ROUTE = new RegExp(`^(?:[A-Za-z][A-Za-z\\d+.-]*:)?//[^/]+/${APP_ROUTE_PREFIX}`)
/** A relative app route reference (`api/x`, `./plugins/x`). */
const RELATIVE_APP_ROUTE = new RegExp(`^(?:\\./)*${APP_ROUTE_PREFIX}`)
/** A shared host route key: the absolute pathname a route is registered under. */
const HOST_ROUTE_KEY = /(?:^|_)(?:PATH|ENDPOINT)$/

/** Request constructors whose first argument addresses a resource. */
const REQUEST_CONSTRUCTORS: Record<string, true> = { Request: true, EventSource: true, WebSocket: true, URL: true }
/** Assigned properties and JSX attributes that address a resource. */
const REQUEST_PROPERTIES: Record<string, true> = { href: true, src: true }
/** Fields a browser resolves against its own document. */
const REFERENCE_FIELDS: Record<string, true> = { url: true, src: true, href: true, initialUrl: true }

/**
 * Static producer of browser references: the node half composes the boot graph
 * the browser resolves against its document. No request-target position in
 * browser code sees those values, so its reference fields are checked directly.
 */
const REFERENCE_PRODUCERS = [
  'packages/client/modules/src/index.ts',
]

/** Rule that produced a violation, for diagnostics and for the gate's own coverage. */
export type RouteResolutionRule = 'request-target' | 'location-base' | 'host-route-key' | 'reference-producer'

/** What a scanned file is: browser face, or a static producer of browser references. */
export type RouteGateFace = 'browser' | 'reference-producer'

const HINT: Record<RouteResolutionRule, string> = {
  'request-target': 'write the route document-relative (api/x)',
  'location-base': 'resolve the route against document.baseURI, not against a location read',
  'host-route-key': 'strip the leading slash before the browser uses this key (KEY.slice(1))',
  'reference-producer': 'emit the browser reference document-relative (plugins/x)',
}

/** One app-owned route reached from a place that binds it to one mount. */
export interface RouteResolutionViolation {
  /** One-based source column. */
  column: number
  /** Repository-relative source path. */
  file: string
  /** One-based source line. */
  line: number
  /** The offending expression, as written. */
  pattern: string
  /** Rule that recognized the route. */
  rule: RouteResolutionRule
}

/** A location expression: `location`, optionally behind its owning global. */
const LOCATION_EXPRESSION = /^(?:(?:window|self|globalThis|document|top|parent|frames)\.)?(?:defaultView\.)?location$/

/** Source text of a location expression, without whitespace. */
function locationText(node: ts.Expression): string | undefined {
  const text = node.getText().replace(/\s+/g, '')
  return LOCATION_EXPRESSION.test(text) ? text : undefined
}

/** Whether an expression rebuilds a base from the page location anywhere inside it. */
function readsLocation(node: ts.Node): boolean {
  if (ts.isExpression(node) && locationText(node) !== undefined) return true
  return node.forEachChild(readsLocation) === true
}

/** Host route keys an expression references without stripping their leading slash. */
function unstrippedHostRouteKeys(node: ts.Node): ts.Identifier[] {
  if (ts.isIdentifier(node)) {
    if (!HOST_ROUTE_KEY.test(node.text)) return []
    const derived = ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'slice'
    return derived ? [] : [node]
  }
  const keys: ts.Identifier[] = []
  node.forEachChild((child) => { keys.push(...unstrippedHostRouteKeys(child)) })
  return keys
}

/** Callee name of a call or construction, for constructors and `fetch`-shaped carriers. */
function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined
}

/**
 * The request target one node carries, when it addresses a resource.
 * @param node - any node visited in the tree.
 * @returns the target expression, or undefined when the node is not a target.
 */
function requestTargetOf(node: ts.Node): ts.Expression | undefined {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node.expression)
    if ((name !== undefined && /fetch(er)?$/iu.test(name)) || node.expression.kind === ts.SyntaxKind.ImportKeyword) return node.arguments[0]
    return undefined
  }
  if (ts.isNewExpression(node)) {
    const name = calleeName(node.expression)
    return name !== undefined && REQUEST_CONSTRUCTORS[name] === true ? node.arguments?.[0] : undefined
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left) && REQUEST_PROPERTIES[node.left.name.text] === true) {
    return node.right
  }
  if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && REQUEST_PROPERTIES[node.name.text] === true) {
    const { initializer } = node
    if (initializer === undefined) return undefined
    return ts.isJsxExpression(initializer) ? initializer.expression : initializer
  }
  return undefined
}

/** One literal fragment of a composed value, with the node that carries it. */
interface LiteralFragment { node: ts.Node; text: string }

/**
 * Literal fragments of a value composed of literals, `+` concatenation,
 * templates, and conditionals. Template fragments are the spans between
 * substitutions, so an interpolated prefix (`${origin}/api/x`) is visible.
 * @param node - the expression to decompose.
 * @returns fragments in source order.
 */
function literalFragments(node: ts.Expression): LiteralFragment[] {
  if (ts.isParenthesizedExpression(node)) return literalFragments(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...literalFragments(node.left), ...literalFragments(node.right)]
  }
  if (ts.isConditionalExpression(node)) {
    return [...literalFragments(node.whenTrue), ...literalFragments(node.whenFalse)]
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [{ node, text: node.text }]
  if (ts.isTemplateExpression(node)) {
    // Every fragment reports the template itself: an interpolated prefix makes
    // the offending span start mid-expression, and one template is one route.
    return [
      { node, text: node.head.text },
      ...node.templateSpans.map(span => ({ node, text: span.literal.text })),
    ]
  }
  return []
}

/**
 * Find app-owned routes that bind one source file to one mount.
 * @param file - repository-relative path used in diagnostics.
 * @param sourceText - TypeScript or TSX source.
 * @param face - `browser` for request targets, `reference-producer` for the
 * fields a static host emits into the browser.
 * @returns violations in source order.
 */
export function findRouteResolutionViolations(
  file: string,
  sourceText: string,
  face: RouteGateFace = 'browser',
): RouteResolutionViolation[] {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const violations = new Map<number, RouteResolutionViolation>()

  const report = (node: ts.Node, rule: RouteResolutionRule): void => {
    const start = node.getStart(source)
    if (violations.has(start)) return
    const { character, line } = source.getLineAndCharacterOfPosition(start)
    violations.set(start, { column: character + 1, file, line: line + 1, pattern: node.getText(source), rule })
  }

  /** A request target's own literals must be document-relative. */
  const checkTarget = (target: ts.Expression): void => {
    for (const fragment of literalFragments(target)) {
      if (ROOT_ABSOLUTE_ROUTE.test(fragment.text) || ABSOLUTE_ROUTE.test(fragment.text)) {
        report(fragment.node, 'request-target')
      }
    }
    // A shared route key used as-is: the browser half strips the leading slash.
    for (const key of unstrippedHostRouteKeys(target)) report(key, 'host-route-key')
  }

  /** A relative app route belongs to the document base, not to a rebuilt origin. */
  const checkUrlBase = (node: ts.NewExpression): void => {
    const [first, second] = node.arguments ?? []
    if (first === undefined || second === undefined || !readsLocation(second)) return
    const literal = literalFragments(first)
    if (literal.some(fragment => RELATIVE_APP_ROUTE.test(fragment.text))) report(first, 'location-base')
  }

  /** A field the browser resolves against its document carries a reference. */
  const checkReferenceField = (value: ts.Expression): void => {
    for (const fragment of literalFragments(value)) {
      if (ROOT_ABSOLUTE_ROUTE.test(fragment.text) || ABSOLUTE_ROUTE.test(fragment.text)) {
        report(fragment.node, 'reference-producer')
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (face === 'browser') {
      const target = requestTargetOf(node)
      if (target !== undefined) checkTarget(target)
      if (ts.isNewExpression(node) && calleeName(node.expression) === 'URL') checkUrlBase(node)
    } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
      && REFERENCE_FIELDS[node.name.text] === true && ts.isExpression(node.initializer)) {
      checkReferenceField(node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  return [...violations.values()].sort((left, right) => left.line - right.line || left.column - right.column)
}

/**
 * Source files of every browser-side TypeScript project in the Client aggregate.
 *
 * A browser half belongs to `src/client`; a package that keeps its whole UI in
 * plain `src` is found through the project itself, which carries the Client
 * compiler shape (DOM libraries). A config the Host aggregate also compiles has
 * a host half rather than a browser-only surface, so its plain `src/` is
 * scanned only when it has no `src/client` half; that half arrives below. Every
 * such face must contribute at least one source file: a face that contributes
 * none means the aggregate's layout moved out from under this discovery, which
 * must fail loud rather than scan less.
 * @param projectRoot - repository root to discover from.
 * @returns sorted repository-relative source paths.
 */
export function browserFaceSources(projectRoot: string = root): string[] {
  const sources = new Set<string>()
  const add = (file: string): void => {
    const normalized = file.replaceAll('\\', '/')
    if (normalized.endsWith('.d.ts')) return
    sources.add(normalized)
  }
  const hostConfigs = faceConfigs(projectRoot, 'host').byPath

  for (const [configPath, parsed] of faceConfigs(projectRoot, 'client').byPath) {
    if (parsed.options.lib?.includes('lib.dom.d.ts') !== true) continue
    const configRoot = dirname(configPath).replaceAll('\\', '/')
    const sourceRoot = `${configRoot}/src/`
    // An aggregate or app shell (the root Client program) carries the compiler
    // shape but no `src/` tree of its own; its browser sources arrive through
    // the references and `src/client` discovery below.
    if (!existsSync(sourceRoot)) continue
    // A package the Host aggregate also compiles has a host half; when its
    // browser half is `src/client`, plain `src/` may hold the node half, and
    // `src/client` alone is scanned below. Without that half, all of `src/` is
    // the browser surface.
    if (hostConfigs.has(configPath) && existsSync(`${configRoot}/src/client`)) continue
    const faceSources = parsed.fileNames.filter((file) => {
      const normalized = file.replaceAll('\\', '/')
      return normalized.startsWith(sourceRoot) && /\.tsx?$/.test(normalized)
    })
    if (faceSources.length === 0) {
      throw new Error(
        `${GATE}: browser face ${relative(projectRoot, configPath).split(sep).join('/')} has DOM libraries but contributes no source file; discovery is broken.`,
      )
    }
    for (const file of faceSources) add(relative(projectRoot, file).split(sep).join('/'))
  }

  for (const file of globSync('packages/*/*/src/client/**/*.{ts,tsx}', { cwd: projectRoot })) {
    add(relative(projectRoot, resolve(projectRoot, file)).split(sep).join('/'))
  }

  return [...sources].sort()
}

/** Scan one file for one face; a producer that disappeared must fail loud. */
function scan(file: string, face: RouteGateFace): RouteResolutionViolation[] {
  const path = resolve(root, file)
  if (face === 'reference-producer' && !existsSync(path)) {
    throw new Error(`${GATE}: browser-reference producer ${file} is gone; discovery is broken.`)
  }
  return findRouteResolutionViolations(file, readFileSync(path, 'utf8'), face)
}

function main(): void {
  const files = browserFaceSources()
  const violations = [
    ...files.flatMap(file => scan(file, 'browser')),
    ...REFERENCE_PRODUCERS.flatMap(file => scan(file, 'reference-producer')),
  ]
  if (violations.length > 0) {
    console.error(`${GATE}: ${violations.length} app-owned route(s) that are not document-relative:`)
    for (const violation of violations) {
      console.error(
        `  ${violation.file}:${violation.line}:${violation.column} ${violation.pattern} — ${HINT[violation.rule]}`,
      )
    }
    process.exitCode = 1
    return
  }
  console.log(
    `${GATE}: ${files.length} browser source file(s) and ${REFERENCE_PRODUCERS.length} browser-reference producer(s) keep app-owned routes document-relative.`,
  )
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
