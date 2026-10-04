/** Source-level adapters for the pinned npm frontend, without writing into node_modules. */
import ts from 'typescript'

/** Fixed npm source snapshot on the Chromium 150 branch's ancestry. */
export const DEVTOOLS_NPM_VERSION = '1.0.1638082'
/** Upstream commit recorded by that npm release. */
export const DEVTOOLS_SOURCE_REVISION = '0e1186138ed519d9659c1874bf6375eca4483c72'

interface Edit { start: number; end: number; text: string }

/**
 * Preserve original module-relative resource URLs after bundling into chunks.
 * @param path - Frontend-relative source path.
 * @param source - Original TypeScript or JavaScript.
 * @returns Source with URL expressions resolved against the frontend's deployed root.
 */
export function restoreModuleUrls(path: string, source: string): string {
  if (!source.includes('import.meta')) return source
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const base = '(typeof document !== "undefined" ? document.baseURI : new URL("../../", self.location.href).href)'
  const moduleUrl = `new URL(${JSON.stringify(path.replace(/\.ts$/u, '.js'))}, ${base}).href`
  const edits: Edit[] = []
  const isMeta = (node: ts.Node): boolean => ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && isMeta(node.expression.expression) && node.expression.name.text === 'resolve') {
      if (node.arguments.length !== 1) throw new Error(`DevTools ${path}: import.meta.resolve must have one argument`)
      edits.push({ start: node.getStart(file), end: node.end, text: `new URL(${node.arguments[0]?.getText(file)}, ${moduleUrl}).href` })
      return
    }
    if (ts.isPropertyAccessExpression(node) && isMeta(node.expression) && node.name.text === 'url') {
      edits.push({ start: node.getStart(file), end: node.end, text: `(${moduleUrl})` })
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return applyEdits(source, edits)
}

/**
 * Set the existing Host CPU profiler as Performance's recording target.
 * @param path - Frontend-relative source path.
 * @param source - Original module source.
 * @returns Source retaining the page target for Elements and the Host target for CPU recording.
 */
export function configureHostPerformanceSource(path: string, source: string): string {
  if (path !== 'panels/timeline/TimelinePanel.ts') return source
  return replaceOnce(replaceOnce(source,
    '#isNode = Root.Runtime.Runtime.isNode();', '#isNode = true;', path),
  'SDK.TargetManager.TargetManager.instance().targets().find(target => target.type() === SDK.Target.Type.NODE)',
  'SDK.TargetManager.TargetManager.instance().primaryPageTarget()', path)
}

/**
 * Compile a stylesheet into the text module consumed by DevTools StyleSheet APIs.
 * @param source - Unmodified stylesheet text.
 * @returns An ESM default export containing the same text.
 */
export function cssTextModule(source: string): string { return `export default ${JSON.stringify(source)};` }

/**
 * Select the standalone browser branch of legacy CodeMirror UMD wrappers used by formatter Workers.
 * @param path - Frontend-relative module path.
 * @param source - Original JavaScript.
 * @returns Browser wrappers without Node require calls activated by bundler-local module variables.
 */
export function configureCodeMirrorBrowser(path: string, source: string): string {
  if (!path.startsWith('third_party/codemirror/package/') || !path.endsWith('.mjs')) return source
  return source.replaceAll('typeof exports == "object" && typeof module == "object"', 'false')
}

function replaceOnce(source: string, before: string, after: string, path: string): string {
  if (source.split(before).length !== 2) throw new Error(`DevTools ${path}: expected source expression changed: ${before}`)
  return source.replace(before, after)
}

function applyEdits(source: string, edits: Edit[]): string {
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  }
  return source
}
