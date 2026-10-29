/**
 * The worker's module transform: one acorn parse turns an ES module into a
 * CommonJS body **and** routes every suspension point through the ambient-store
 * protocol.
 *
 * Both jobs live in one pass because they are two edits over one syntax tree;
 * running a lexer first and a parser second meant two scanners, two sets of
 * blind spots, and a second pass reading the first pass's output. Editing is
 * interval-based — the original text is sliced and spliced, never reprinted —
 * so **line numbers survive**: a stack frame in a transformed module points at
 * the same line as the built artifact it came from.
 *
 * The image packer is this transform's only caller: it lowers every JavaScript
 * entry it packs and records `LOWERING_VERSION` in the image manifest, so the
 * worker wraps those bodies without carrying a compiler of its own.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/compile/transform
 */
import { parse } from 'acorn'

const HELPER_SOURCE: Record<string, string> = {
  def: 'const __dsh$def=(t,k,get)=>Object.defineProperty(t,k,{enumerable:true,configurable:true,get});',
  default: 'const __dsh$default=(m)=>(m&&m.__esModule&&Object.prototype.hasOwnProperty.call(m,"default")?m.default:m);',
  ns: 'const __dsh$ns=(m)=>(m&&m.__esModule?m:Object.assign({},m,{default:m}));',
  exportAll: 'const __dsh$exportAll=(t,m)=>{for(const k of Object.keys(m))if(k!=="default"&&!(k in t))__dsh$def(t,k,()=>m[k]);};',
  dynImport: 'const __dsh$dynImport=(s)=>Promise.resolve().then(()=>__dsh$ns(require(s)));',
}

const HELPER_DEPENDENCIES: Record<string, readonly string[]> = {
  exportAll: ['def'],
  dynImport: ['ns'],
}

/** Runtime identifier the suspension protocol reaches. */
const ALS = '__als'

interface Node {
  readonly type: string
  readonly start: number
  readonly end: number
  readonly [key: string]: unknown
}

/** @returns Number of line breaks in a slice. */
function countNewlines(text: string): number {
  let count = 0
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) count += 1
  return count
}

interface Edit {
  readonly start: number
  readonly end: number
  /** Rendered lazily so edits inside a replaced range still apply. */
  readonly render: (inner: (from: number, to: number) => string) => string
}

/** One binding to publish on `exports`. */
interface Binding {
  readonly exported: string
  readonly local: string
}

class Transformer {
  private readonly edits: Edit[] = []
  private readonly source: string
  private readonly helpers = new Set<string>()
  private readonly bindings: Binding[] = []
  private modules = 0
  private temporaries = 0
  private moduleSyntax = false
  private readonly moduleRequests = new Set<string>()
  private readonly metaResolveRequests = new Set<string>()
  private readonly createRequireBindings = new Set<string>()

  constructor(source: string, private readonly path: string) {
    // A `#!` line is only legal at offset zero, and the prologue takes that spot;
    // commenting it out in place keeps every offset and the line count intact.
    this.source = source.startsWith('#!') ? `//${source.slice(2)}` : source
  }

  private fail(detail: string, index: number): never {
    const line = this.source.slice(0, index).split('\n').length
    throw new Error(`webworker transform: ${detail} (${this.path}:${line})`)
  }

  private helper(name: string): string {
    for (const dependency of HELPER_DEPENDENCIES[name] ?? []) this.helper(dependency)
    this.helpers.add(name)
    return `__dsh$${name}`
  }

  private moduleTemp(): string {
    this.modules += 1
    return `__dsh$m${this.modules}`
  }

  private alsTemp(): string {
    this.temporaries += 1
    return `__als$${this.temporaries}`
  }

  /**
   * Replace a range, keeping the module's line count.
   *
   * The padding is the newlines the original range held **minus** the ones the
   * replacement re-emits: a rewrite that splices the original body back in
   * (a desugared loop) already carries that body's newlines, and padding by the
   * whole range again would push every later line down.
   */
  private edit(start: number, end: number, build: (inner: (from: number, to: number) => string) => string): void {
    const original = countNewlines(this.source.slice(start, end))
    this.edits.push({
      start,
      end,
      render: (inner) => {
        const text = build(inner)
        return text + '\n'.repeat(Math.max(0, original - countNewlines(text)))
      },
    })
  }

  private replace(start: number, end: number, text: string): void {
    this.edit(start, end, () => text)
  }

  private insert(at: number, text: string): void {
    this.edits.push({ start: at, end: at, render: () => text })
  }

  private structural(start: number, end: number, render: Edit['render']): void {
    this.edit(start, end, render)
  }

  private literal(node: Node): string {
    const value = node.value
    if (typeof value !== 'string') this.fail('a module specifier must be a string literal', node.start)
    this.moduleRequests.add(value)
    return JSON.stringify(value)
  }

  /** @returns Static module requests the body makes, in first-appearance order. */
  requests(): readonly string[] {
    return [...this.moduleRequests]
  }

  /** @returns Literal `import.meta.resolve()` requests, in first-appearance order. */
  metaRequests(): readonly string[] {
    return [...this.metaResolveRequests]
  }

  // --- module syntax --------------------------------------------------------

  private importDeclaration(node: Node): void {
    this.moduleSyntax = true
    if (Array.isArray(node.attributes) && node.attributes.length > 0) {
      this.fail('import attributes are not supported', node.start)
    }
    const source = node.source as Node
    const request = `require(${this.literal(source)})`
    const specifiers = node.specifiers as Node[]
    if (specifiers.length === 0) {
      this.replace(node.start, node.end, `${request};`)
      return
    }
    const held = this.moduleTemp()
    const lines = [`const ${held}=${request};`]
    for (const specifier of specifiers) {
      const local = (specifier.local as Node).name as string
      if (specifier.type === 'ImportDefaultSpecifier') {
        lines.push(`const ${local}=${this.helper('default')}(${held});`)
        continue
      }
      if (specifier.type === 'ImportNamespaceSpecifier') {
        lines.push(`const ${local}=${this.helper('ns')}(${held});`)
        continue
      }
      const imported = specifier.imported as Node
      const name = imported.type === 'Identifier' ? imported.name as string : imported.value as string
      lines.push(`const ${local}=${held}[${JSON.stringify(name)}];`)
    }
    this.replace(node.start, node.end, lines.join(''))
  }

  private exportNamed(node: Node): void {
    this.moduleSyntax = true
    const declaration = node.declaration as Node | null
    const source = node.source as Node | null
    const specifiers = node.specifiers as Node[]

    if (declaration !== null) {
      // `export const x = 1` keeps its declaration; only the keyword goes.
      this.replace(node.start, declaration.start, '')
      for (const { exported, local } of declaredBindings(declaration, detail => this.fail(detail, declaration.start))) {
        this.bindings.push({ exported, local })
      }
      return
    }
    if (source !== null) {
      const held = this.moduleTemp()
      const define = this.helper('def')
      const lines = [`const ${held}=require(${this.literal(source)});`]
      for (const specifier of specifiers) {
        const local = nameOf(specifier.local as Node)
        const exported = nameOf(specifier.exported as Node)
        lines.push(`${define}(exports,${JSON.stringify(exported)},()=>${held}[${JSON.stringify(local)}]);`)
      }
      this.replace(node.start, node.end, lines.join(''))
      return
    }
    // A bare `export {}` is a module marker with nothing to publish.
    for (const specifier of specifiers) {
      this.bindings.push({ exported: nameOf(specifier.exported as Node), local: nameOf(specifier.local as Node) })
    }
    this.replace(node.start, node.end, '')
  }

  private exportDefault(node: Node): void {
    this.moduleSyntax = true
    const declaration = node.declaration as Node
    this.replace(node.start, declaration.start, 'exports.default = ')
  }

  private exportAll(node: Node): void {
    this.moduleSyntax = true
    const request = `require(${this.literal(node.source as Node)})`
    const exported = node.exported as Node | null
    if (exported === null) {
      this.replace(node.start, node.end, `${this.helper('exportAll')}(exports,${request});`)
      return
    }
    const held = this.moduleTemp()
    const define = this.helper('def')
    this.replace(
      node.start,
      node.end,
      `const ${held}=${this.helper('ns')}(${request});${define}(exports,${JSON.stringify(nameOf(exported))},()=>${held});`,
    )
  }

  // --- suspension points ----------------------------------------------------

  private awaitExpression(node: Node): void {
    const keywordEnd = node.start + 'await'.length
    if (this.source.slice(node.start, keywordEnd) !== 'await') this.fail('unexpected await layout', node.start)
    this.replace(node.start, keywordEnd, `${ALS}.resume(await ${ALS}.pause(`)
    this.insert(node.end, '))')
  }

  /**
   * `for await (L of R) B` becomes an explicit loop over the same protocol.
   * `iterator.return` runs only on abrupt completion, as the language says, and
   * is awaited so teardown still orders before the loop exits.
   */
  private forAwait(node: Node): void {
    const left = node.left as Node
    const right = node.right as Node
    const body = node.body as Node
    const iterator = this.alsTemp()
    const step = this.alsTemp()
    const exhausted = this.alsTemp()
    const binding = (inner: (from: number, to: number) => string): string => {
      if (left.type !== 'VariableDeclaration') return `(${inner(left.start, left.end)})=${step}.value;`
      const declarations = left.declarations as Node[]
      const pattern = declarations[0]?.id as Node | undefined
      if (declarations.length !== 1 || pattern === undefined) {
        this.fail('for-await must declare exactly one binding', left.start)
      }
      return `${String(left.kind)} ${inner(pattern.start, pattern.end)}=${step}.value;`
    }
    this.structural(node.start, node.end, inner => [
      `{const ${iterator}=${ALS}.iterator(${inner(right.start, right.end)});`,
      `let ${step};let ${exhausted}=false;`,
      `try{for(;;){${step}=${ALS}.resume(await ${ALS}.pause(${iterator}.next()));`,
      `if(${step}.done){${exhausted}=true;break}`,
      `{${binding(inner)}${body.type === 'BlockStatement' ? inner(body.start, body.end) : `{${inner(body.start, body.end)}}`}}}}`,
      `finally{if(!${exhausted})${ALS}.resume(await ${ALS}.pause(${ALS}.close(${iterator})))}}`,
    ].join(''))
  }

  /**
   * `yield` resumes with whatever the consumer sent, so the snapshot is taken
   * before suspending and restored when the call completes. `yield*` delegates,
   * which has no expression form here: it is desugared as a statement, and a
   * consumer's `throw()` is not forwarded into the inner iterator (`next` and
   * `return` are).
   */
  private yieldExpression(node: Node, statement: Node | undefined): void {
    if (node.delegate !== true) {
      this.insert(node.start, `${ALS}.afterYield(${ALS}.snapshot(),`)
      this.insert(node.end, ')')
      return
    }
    const argument = node.argument as Node | null
    if (argument === null) this.fail('yield* without an operand', node.start)
    if (statement === undefined) this.fail('yield* is only supported as a statement', node.start)
    if ((statement.expression as Node) !== node) {
      // Anything around the delegation (`x = yield* g()`, `f(yield* g())`)
      // would be silently dropped by the statement-wide rewrite below; the
      // all-or-nothing lowering contract demands a loud refusal instead.
      this.fail('yield* is only supported as the whole statement expression', node.start)
    }
    const iterator = this.alsTemp()
    const step = this.alsTemp()
    const sent = this.alsTemp()
    const exhausted = this.alsTemp()
    this.structural(statement.start, statement.end, inner => [
      `{const ${iterator}=${ALS}.iterator(${inner(argument.start, argument.end)});`,
      `let ${sent};let ${exhausted}=false;`,
      `try{for(;;){const ${step}=${ALS}.resume(await ${ALS}.pause(${iterator}.next(${sent})));`,
      `if(${step}.done){${exhausted}=true;break}`,
      `${sent}=${ALS}.afterYield(${ALS}.snapshot(),yield ${step}.value)}}`,
      `finally{if(!${exhausted})${ALS}.resume(await ${ALS}.pause(${ALS}.close(${iterator})))}}`,
    ].join(''))
  }

  // --- traversal ------------------------------------------------------------

  private visit(node: unknown, context: {
    asyncGenerator: boolean
    functionDepth: number
    moduleScope: boolean
    statement?: Node
  }): void {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) this.visit(child, context)
      return
    }
    const record = node as Node
    if (typeof record.type !== 'string') return
    let next = context
    switch (record.type) {
      case 'ImportDeclaration': this.importDeclaration(record); break
      case 'ExportNamedDeclaration': this.exportNamed(record); break
      case 'ExportDefaultDeclaration': this.exportDefault(record); break
      case 'ExportAllDeclaration': this.exportAll(record); break
      case 'ImportExpression': {
        this.moduleSyntax = true
        if (!this.source.startsWith('import', record.start)) this.fail('unexpected dynamic import layout', record.start)
        this.replace(record.start, record.start + 'import'.length, this.helper('dynImport'))
        // A computed dynamic import stays out of the request list; resolution
        // then happens (and fails loud) at runtime, never silently at pack time.
        const argument = record.source as Node | undefined
        if (argument !== undefined && typeof argument.value === 'string') this.moduleRequests.add(argument.value)
        break
      }
      case 'CallExpression': {
        // CommonJS bodies pass through untransformed, but literal calls through
        // the wrapper's `require` remain module requests. The ESM case accepts
        // only a direct module-scope createRequire call with the importer URL.
        const callee = record.callee as Node
        const callArguments = record.arguments as Node[]
        if (this.isRequireCall(callee, context.moduleScope) && callArguments.length === 1
          && typeof callArguments[0]?.value === 'string') {
          this.moduleRequests.add(callArguments[0].value)
        }
        // `import.meta.resolve('lit')` is the third static request face: the
        // loader answers it from the image, so the pack sweep must keep the
        // target. A computed argument stays out, same as dynamic import —
        // resolution then fails loud at runtime, never silently at pack time.
        if (callee.type === 'MemberExpression') {
          const object = callee.object as Node
          const property = callee.property as Node
          if (object.type === 'MetaProperty' && (object.meta as Node).name === 'import'
            && property.type === 'Identifier' && property.name === 'resolve'
            && typeof callArguments[0]?.value === 'string') {
            this.metaResolveRequests.add(callArguments[0].value)
          }
        }
        break
      }
      case 'MetaProperty': {
        // `new.target` is a MetaProperty too, and it must survive untouched:
        // the abstract-seam guards in the roster read it (`new.target === X`).
        const meta = record.meta as Node
        if (meta.name === 'import') {
          this.moduleSyntax = true
          this.replace(record.start, record.end, '__dsh$meta')
        }
        break
      }
      case 'AwaitExpression':
        if (context.functionDepth === 0) {
          this.fail('top-level await cannot run as CommonJS in the worker', record.start)
        }
        this.awaitExpression(record)
        break
      case 'ForOfStatement':
        if (record.await === true) {
          if (context.functionDepth === 0) this.fail('a top-level for-await loop cannot run as CommonJS', record.start)
          this.forAwait(record)
        }
        next = { ...next, moduleScope: false }
        break
      case 'LabeledStatement': {
        const body = record.body as Node
        if (body.type === 'ForOfStatement' && body.await === true) {
          this.fail('a labeled for-await loop is not supported', record.start)
        }
        break
      }
      case 'YieldExpression':
        if (context.asyncGenerator) this.yieldExpression(record, context.statement)
        break
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        next = {
          asyncGenerator: record.async === true && record.generator === true,
          functionDepth: context.functionDepth + 1,
          moduleScope: false,
        }
        break
      case 'BlockStatement':
      case 'CatchClause':
      case 'ClassBody':
      case 'ForStatement':
      case 'ForInStatement':
      case 'SwitchStatement':
        next = { ...next, moduleScope: false }
        break
      default: break
    }
    if (record.type === 'ExpressionStatement') next = { ...next, statement: record }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      this.visit(value, next)
    }
  }

  private isCreateRequireCall(node: Node): boolean {
    if (node.type !== 'CallExpression') return false
    const callee = node.callee as Node
    const args = node.arguments as Node[]
    if (callee.type !== 'Identifier' || !this.createRequireBindings.has(nameOf(callee)) || args.length !== 1) {
      return false
    }
    const base = args[0] as Node
    if (base.type !== 'MemberExpression' || base.computed === true) return false
    const object = base.object as Node
    const property = base.property as Node
    return object.type === 'MetaProperty'
      && (object.meta as Node).name === 'import'
      && property.type === 'Identifier'
      && property.name === 'url'
  }

  private isRequireCall(callee: Node, moduleScope: boolean): boolean {
    return (callee.type === 'Identifier' && callee.name === 'require')
      || (moduleScope && this.isCreateRequireCall(callee))
  }

  private indexCreateRequireImports(program: Node): void {
    for (const statement of program.body as Node[]) {
      if (statement.type !== 'ImportDeclaration') continue
      const source = statement.source as Node
      if (source.value !== 'node:module' && source.value !== 'module') continue
      for (const specifier of statement.specifiers as Node[]) {
        if (specifier.type !== 'ImportSpecifier' || nameOf(specifier.imported as Node) !== 'createRequire') continue
        this.createRequireBindings.add(nameOf(specifier.local as Node))
      }
    }
  }

  run(): string {
    // Transforming a lowered body again would nest the protocol inside itself:
    // it still runs, only slower and unreadable, so a mis-wired manifest must
    // surface here rather than as a silent tax on every load.
    if (this.source.includes(`${ALS}.pause(`) || this.source.includes('__als$')) {
      this.fail('the module is already lowered; check the image manifest wiring', 0)
    }
    let program: Node
    try {
      program = parse(this.source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowAwaitOutsideFunction: true,
      }) as unknown as Node
    } catch (reason) {
      this.fail(`parse failed: ${(reason as Error).message}`, 0)
    }
    this.indexCreateRequireImports(program)
    this.visit(program, { asyncGenerator: false, functionDepth: 0, moduleScope: true })
    if (this.edits.length === 0 && !this.moduleSyntax) return this.source

    const prologue: string[] = []
    if (this.moduleSyntax) prologue.push('"use strict";Object.defineProperty(exports,"__esModule",{value:true});')
    if (this.bindings.length > 0) this.helper('def')
    for (const [name, source] of Object.entries(HELPER_SOURCE)) {
      if (this.helpers.has(name)) prologue.push(source)
    }
    for (const { exported, local } of this.bindings) {
      prologue.push(`__dsh$def(exports,${JSON.stringify(exported)},()=>${local});`)
    }

    const sorted = [...this.edits].sort((left, right) => left.start - right.start || left.end - right.end)
    const render = (from: number, to: number): string => {
      let cursor = from
      let out = ''
      for (const edit of sorted) {
        if (edit.start < cursor || edit.end > to) continue
        out += this.source.slice(cursor, edit.start) + edit.render(render)
        cursor = edit.end
      }
      return out + this.source.slice(cursor, to)
    }
    const code = prologue.join('') + render(0, this.source.length)
    // Proof that the emitted body is CommonJS a wrapper can compile: any leftover
    // module syntax, or any mis-spliced interval, fails here rather than at load.
    try {
      parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: false })
    } catch (reason) {
      this.fail(`the transform produced code that does not parse: ${(reason as Error).message}`, 0)
    }
    return code
  }
}

/** @returns The name a specifier or identifier node carries. */
function nameOf(node: Node): string {
  return node.type === 'Identifier' ? node.name as string : String(node.value)
}

/** Every binding an exported declaration introduces, including patterns. */
function declaredBindings(declaration: Node, fail: (detail: string) => never): Binding[] {
  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
    const id = declaration.id as Node | null
    if (id === null) fail('an exported declaration must be named')
    const name = id.name as string
    return [{ exported: name, local: name }]
  }
  if (declaration.type !== 'VariableDeclaration') fail(`unsupported exported declaration ${declaration.type}`)
  const bindings: Binding[] = []
  const collect = (pattern: Node): void => {
    switch (pattern.type) {
      case 'Identifier':
        bindings.push({ exported: pattern.name as string, local: pattern.name as string })
        return
      case 'ObjectPattern':
        for (const property of pattern.properties as Node[]) {
          collect((property.type === 'RestElement' ? property.argument : property.value) as Node)
        }
        return
      case 'ArrayPattern':
        for (const element of pattern.elements as Array<Node | null>) if (element !== null) collect(element)
        return
      case 'AssignmentPattern':
        collect(pattern.left as Node)
        return
      case 'RestElement':
        collect(pattern.argument as Node)
        return
      default:
        fail(`unsupported binding pattern ${pattern.type}`)
    }
  }
  for (const declarator of declaration.declarations as Node[]) collect(declarator.id as Node)
  return bindings
}

interface TransformedModule {
  readonly code: string
  readonly moduleRequests: readonly string[]
  readonly metaResolveRequests: readonly string[]
}

const cache = new Map<string, TransformedModule>()

/**
 * Transform one module into a body for the worker wrapper.
 *
 * Results are cached by source text, so a module reached through two paths, or
 * a repeated build, parses once.
 * @param source - Module source, ESM or CommonJS.
 * @param path - Path used in diagnostics.
 * @returns The lowered body and the module requests found in it.
 */
function transformDetailed(source: string, path: string): TransformedModule {
  const cached = cache.get(source)
  if (cached !== undefined) return cached
  const transformer = new Transformer(source, path)
  const transformed = { code: transformer.run(), moduleRequests: transformer.requests(), metaResolveRequests: transformer.metaRequests() }
  cache.set(source, transformed)
  return transformed
}

/** One module the collector considered. */
export interface LoweredModule {
  /** Transformed body, or the input unchanged when nothing needed lowering. */
  readonly code: string
  /** False means the entry may be packed as it is. */
  readonly lowered: boolean
  /**
   * Static module requests the body makes: import and re-export sources,
   * literal dynamic imports and calls through `require`, plus module-scope
   * direct literal calls through an imported `createRequire(import.meta.url)`.
   * Computed and rebased requests resolve (and fail loud) at runtime only.
   */
  readonly moduleRequests: readonly string[]
  /**
   * Literal `import.meta.resolve()` requests. These are URL mappings, not
   * loads: the pack sweep keeps a resolvable target and tolerates a missing
   * one, and the loader answers or throws at the call site.
   */
  readonly metaResolveRequests: readonly string[]
}

/**
 * Lower one module at image-pack time.
 *
 * The collector calls this for every JavaScript entry it packs and records
 * `LOWERING_VERSION` in the image manifest; the loader then wraps those entries
 * without parsing them. `lowered: false` reports that the transform would have
 * returned the input verbatim (already CommonJS, no suspension point), so the
 * entry may be packed as it is.
 *
 * Throwing is the intended failure mode: a module this transform cannot express
 * must fail the build rather than ship an image that breaks at load.
 * @param options - Virtual path inside the image and the module source.
 * @returns The code to pack and whether it changed.
 */
export function lowerModuleSource(options: { readonly filename: string; readonly source: string }): LoweredModule {
  const { code, moduleRequests, metaResolveRequests } = transformDetailed(options.source, options.filename)
  return { code, lowered: code !== options.source, moduleRequests, metaResolveRequests }
}
