/**
 * Node REPL top-level-await transformation adapted for complete Script submissions.
 * Source: Node.js v26.6.0, lib/internal/repl/await.js:
 * https://github.com/nodejs/node/blob/v26.6.0/lib/internal/repl/await.js
 * Uses public Acorn and acorn-walk; incomplete input is a SyntaxError.
 */
/*! @license
 * Copyright Node.js contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import { Parser } from 'acorn'
import type { AnyNode, BlockStatement, ExpressionStatement, Identifier, Pattern, Position, Program, Statement, VariableDeclarator } from 'acorn'
import * as walk from 'acorn-walk'

interface TransformState {
  body: BlockStatement
  ancestors: AnyNode[]
  hoistedDeclarationStatements: string[]
  replace(from: number, to: number, str: string): void
  prepend(node: AnyNode, str: string): void
  append(node: AnyNode, str: string): void
  containsAwait: boolean
  containsReturn: boolean
}

function isTopLevelDeclaration(state: TransformState): boolean {
  return state.ancestors[state.ancestors.length - 2] === state.body
}

const noop = (): void => {}
const base = walk.base as Required<walk.RecursiveVisitors<TransformState>>
const visitorsWithoutAncestors: walk.RecursiveVisitors<TransformState> = {
  ClassDeclaration(node, state, c) {
    // Anonymous declarations are invalid inside the parsed async body.
    const name = (node.id as Identifier).name
    if (isTopLevelDeclaration(state)) {
      state.prepend(node, `${name}=`)
      state.hoistedDeclarationStatements.push(`let ${name}; `)
    }

    base.ClassDeclaration(node, state, c)
  },
  ForOfStatement(node, state, c) {
    if (node.await) {
      state.containsAwait = true
    }
    base.ForOfStatement(node, state, c)
  },
  FunctionDeclaration(node, state) {
    // Anonymous declarations are invalid inside the parsed async body.
    const name = (node.id as Identifier).name
    state.prepend(node, `this.${name} = ${name}; `)
    state.hoistedDeclarationStatements.push(`var ${name}; `)
  },
  FunctionExpression: noop,
  ArrowFunctionExpression: noop,
  MethodDefinition(node, state, c) {
    // Computed keys execute while the class is defined; method bodies do not.
    if (node.computed) c(node.key, state)
  },
  StaticBlock: noop,
  AwaitExpression(node, state, c) {
    state.containsAwait = true
    base.AwaitExpression(node, state, c)
  },
  ReturnStatement(node, state, c) {
    state.containsReturn = true
    base.ReturnStatement(node, state, c)
  },
  VariableDeclaration(node, state, c) {
    const variableKind = node.kind
    if (variableKind === 'await using') state.containsAwait = true
    const parent = state.ancestors[state.ancestors.length - 2]
    const isIterableForDeclaration = parent !== undefined && ['ForOfStatement', 'ForInStatement'].includes(parent.type)

    if (variableKind === 'var' || isTopLevelDeclaration(state)) {
      // Disposable bindings cannot outlive the async body's disposal scope.
      if (variableKind === 'using' || variableKind === 'await using') {
        throw new SyntaxError('Put using declarations inside a block; Script evaluations do not retain disposable bindings')
      }
      state.replace(
        node.start,
        node.start + variableKind.length,
        variableKind === 'var' && isIterableForDeclaration
          ? ''
          : 'void' + (node.declarations.length === 1 ? '' : ' ('),
      )

      if (!isIterableForDeclaration) {
        node.declarations.forEach((decl) => {
          state.prepend(decl, '(')
          state.append(decl, decl.init ? ')' : '=undefined)')
        })

        if (node.declarations.length !== 1) {
          state.append(node.declarations[node.declarations.length - 1] as VariableDeclarator, ')')
        }
      }

      const variableIdentifiersToHoist: [['var', string[]], ['let', string[]]] = [
        ['var', []],
        ['let', []],
      ]
      function registerVariableDeclarationIdentifiers(node: Pattern): void {
        switch (node.type) {
          case 'Identifier':
            variableIdentifiersToHoist[variableKind === 'var' ? 0 : 1][1].push(node.name)
            break
          case 'ObjectPattern':
            node.properties.forEach((property) => {
              registerVariableDeclarationIdentifiers(property.type === 'RestElement' ? property.argument : property.value)
            })
            break
          case 'ArrayPattern':
            node.elements.forEach((element) => {
              if (element) registerVariableDeclarationIdentifiers(element)
            })
            break
          // Acorn exposes defaults and rest elements as separate binding nodes.
          case 'AssignmentPattern':
            registerVariableDeclarationIdentifiers(node.left)
            break
          case 'RestElement':
            registerVariableDeclarationIdentifiers(node.argument)
            break
          /* v8 ignore next 4 -- Acorn declaration bindings exclude member targets and other node tags. */
          case 'MemberExpression':
            throw new SyntaxError('A declaration cannot bind a member expression')
          /* v8 ignore next -- The parsed Pattern union is exhaustive above. */
          default: return assertNever(node)
        }
      }

      node.declarations.forEach((decl) => {
        registerVariableDeclarationIdentifiers(decl.id)
      })

      variableIdentifiersToHoist.forEach(({ 0: kind, 1: identifiers }) => {
        if (identifiers.length > 0) {
          state.hoistedDeclarationStatements.push(`${kind} ${identifiers.join(', ')}; `)
        }
      })
    }

    base.VariableDeclaration(node, state, c)
  },
}

type Visitor = (node: AnyNode, state: TransformState, c: walk.WalkerCallback<TransformState>) => void
const visitors: walk.RecursiveVisitors<TransformState> = Object.fromEntries(
  Object.entries({ ...base, ...visitorsWithoutAncestors }).map(([type, visitor]) => {
    // acorn-walk selects the callback by the matching node or aggregate type.
    const callback = visitor as Visitor
    const withAncestors: Visitor = (node, state, c) => {
      const isNew = node !== state.ancestors[state.ancestors.length - 1]
      if (isNew) state.ancestors.push(node)
      callback(node, state, c)
      if (isNew) state.ancestors.pop()
    }
    return [type, withAncestors]
  }),
)

/** Keep the native-Node bootstrap independent of workspace packages' built exports. */
/* v8 ignore next 3 -- Exhaustive declaration-tag assertion; parsed bindings cannot reach it. */
function assertNever(value: never): never {
  throw new Error(`Unexpected declaration pattern: ${String(value)}`)
}

/**
 * Transform top-level await using Node's retained-declaration and boxed-result convention.
 * @param src - Type-stripped JavaScript ending in a newline, with any hashbang removed.
 * @returns Transformed source yielding undefined or { value }, or null when native errors apply.
 * @throws SyntaxError for invalid syntax or unsupported top-level disposable bindings.
 */
export function processTopLevelAwait(src: string): string | null {
  const wrapPrefix = '(async () => { '
  const wrapped = `${wrapPrefix}${src} })()`
  const wrappedArray = wrapped.split('')
  let root: Program
  try {
    root = Parser.parse(wrapped, { ecmaVersion: 'latest' })
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error
    // Acorn syntax errors include offsets and positions; batches cannot request more REPL input.
    const e = error as SyntaxError & { pos: number; loc: Position }
    // If the parse error is before the first "await", then use the execution
    // error. Otherwise we must emit this parse error, making it look like a
    // proper syntax error.
    const awaitPos = src.indexOf('await')
    const errPos = e.pos - wrapPrefix.length
    if (awaitPos > errPos) return null
    // Convert keyword parse errors on await into their original errors when
    // possible.
    if (errPos === awaitPos + 6 && e.message.includes('Expecting Unicode escape sequence')) return null
    if (errPos === awaitPos + 7 && e.message.includes('Unexpected token')) return null
    const line = e.loc.line
    const column = line === 1 ? e.loc.column - wrapPrefix.length : e.loc.column
    let message = '\n' + (src.split('\n', line)[line - 1] as string) + '\n'
      + ' '.repeat(column) + '^\n\n' + e.message.replace(/ \([^)]+\)/, '')
    // V8 unexpected token errors include the token string.
    if (message.endsWith('Unexpected token')) {
      message += " '"
        // Wrapper end may cause acorn to report error position after the source
        + ((src[e.pos - wrapPrefix.length] ?? src[src.length - 1]) as string) + "'"
    }
    throw new SyntaxError(message)
  }
  // The fixed prefix starts an expression statement and an arrow with a block body.
  const expression = (root.body[0] as ExpressionStatement).expression
  if (expression.type !== 'CallExpression' || expression.callee.type !== 'ArrowFunctionExpression') return null
  const body = expression.callee.body as BlockStatement
  const state: TransformState = {
    body,
    ancestors: [],
    hoistedDeclarationStatements: [],
    replace(from, to, str) {
      for (let i = from; i < to; i++) {
        wrappedArray[i] = ''
      }
      wrappedArray[from] = str
    },
    prepend(node, str) {
      wrappedArray[node.start] = str + (wrappedArray[node.start] as string)
    },
    append(node, str) {
      wrappedArray[node.end - 1] = (wrappedArray[node.end - 1] as string) + str
    },
    containsAwait: false,
    containsReturn: false,
  }

  walk.recursive(body, state, visitors)

  // Do not transform if
  // 1. False alarm: there isn't actually an await expression.
  // 2. There is a top-level return, which is not allowed.
  if (!state.containsAwait || state.containsReturn) {
    return null
  }

  for (let i = body.body.length - 1; i >= 0; i--) {
    const node = body.body[i] as Statement
    if (node.type === 'EmptyStatement') continue
    if (node.type === 'ExpressionStatement') {
      // For an expression statement of the form
      // ( expr ) ;
      // ^^^^^^^^^^   // node
      //   ^^^^       // node.expression
      //
      // We do not want the left parenthesis before the `return` keyword;
      // therefore we prepend the `return (` to `node`.
      //
      // On the other hand, we do not want the right parenthesis after the
      // semicolon. Since there can only be more right parentheses between
      // node.expression.end and the semicolon, appending one more to
      // node.expression should be fine.
      //
      // We also create a wrapper object around the result of the expression.
      // Consider an expression of the form `(await x).y`. If we just return
      // this expression from an async function, the caller will await `y`, too,
      // if it evaluates to a Promise. Instead, we return
      // `{ value: ((await x).y) }`, which allows the caller to retrieve the
      // awaited value correctly.
      state.prepend(node.expression, '{ value: (')
      state.prepend(node, 'return ')
      state.append(node.expression, ') }')
    }
    break
  }

  return state.hoistedDeclarationStatements.join('') + wrappedArray.join('')
}
